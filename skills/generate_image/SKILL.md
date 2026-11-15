---
name: generate_image
description: Generate or edit images with Google Gemini image models via the @the-focus-ai/nano-banana CLI, including prompt structure and the command's real flags.
---

# Generate Image (nano-banana, Gemini)

Create an image from a text prompt, or edit an existing image, using Google's
Gemini image models through the `@the-focus-ai/nano-banana` CLI.

Use this when the user asks for a picture, diagram, illustration, logo, icon,
hero image, mockup, or asks to change an existing image.

## Requirements

- `GEMINI_API_KEY` set in the environment (the CLI loads `.env` itself via
  dotenv, so a project `.env` works). Get a key from
  <https://aistudio.google.com/apikey>.
- `npx` on `PATH`, or a global install: `npm install -g @the-focus-ai/nano-banana`.
- Never print the key or echo `.env`. If the key is missing the CLI exits 1
  with `GEMINI_API_KEY environment variable is not set`.

**Verifying the key before blaming the prompt:** run
`npx @the-focus-ai/nano-banana --list-models`, which prints the image and video
models the key can actually reach. A key can authenticate and still be denied a
model, so check this before concluding a prompt is refused.

**The saved file is not always the format its name claims.** Observed: a request
with `--output images/x.png` wrote **JPEG** bytes (`FF D8 FF E0`) into a `.png`
file. Decoders sniff content, so it usually still opens, but rename or convert
if a strict consumer needs a real PNG:

```bash
npx @the-focus-ai/nano-banana "a red circle" --output out.img
head -c 4 out.img | od -An -tx1   # ffd8ffe0 = JPEG
```

## Command shape

`nano-banana <prompt> [options]` — the prompt is a positional argument, or
`--prompt "<text>"`, or `--prompt-file <path>`.

| Option | Meaning |
| --- | --- |
| `--file <image>` | Input image to **edit**; omit for text-to-image |
| `--output <file>` | Output path. Default: `output/generated-<timestamp>.png` |
| `--model <name>` | Gemini model. Default `gemini-3.1-flash-image-preview` |
| `--flash` | Use `gemini-2.5-flash-image` — faster, lower quality |
| `--prompt-file <path>` | Read the prompt from a file (cannot be combined with a prompt argument) |
| `--list-models` | List available image and Veo models, then exit |
| `--help`, `-h` | Print usage |

The CLI pretty-prints the model's text response, writes the image, and prints
`Image saved: <path>`. If it prints `No image in response.` the model refused or
returned text only — read the printed response before retrying.

## Prompt structure

Build the prompt in layers, most important first:

```
[Subject] + [Action/State] + [Setting] + [Style] + [Technical] + [Exclusions]
```

1. **Subject** — specific, not generic ("a fluffy orange tabby cat" not "a cat").
2. **Action/state** — what it is doing or its mood.
3. **Setting** — location, time of day, atmosphere.
4. **Style** — name a medium: "watercolour", "flat vector illustration",
   "photorealistic, 85mm lens", "editorial magazine photography", "anime, cel shaded".
5. **Technical** — framing and light: "close-up", "wide 16:9", "golden hour",
   "soft diffused studio light", "high contrast".
6. **Exclusions** — what to avoid: "NO text, NO watermark, NO dark background".

Length guidance: 10–20 words for icons and abstract shapes, 30–60 words for most
requests, 80+ only when the scene genuinely has that much structure. Gemini
handles long prompts well; vagueness hurts more than length.

### Weak vs strong

```
# weak
a mountain

# strong
A dramatic mountain landscape, snow-capped peaks reflected in a still alpine
lake at sunset. Golden hour lighting, wide panoramic composition, professional
landscape photography. NO people, NO text, NO man-made structures.
```

### Diagram prompts (common here)

For a flow chart or architecture diagram, say so and enumerate the boxes and
arrows explicitly, because the model cannot infer your actual system:

```
A clean flat-design technical flow diagram on a white background, reading left
to right. Boxes labelled "Load", "Parse", "Validate", "Write", connected by
right-pointing arrows. Each box is a rounded rectangle with a thin dark outline,
teal accent line, sans-serif labels, generous whitespace. NO decorative icons,
NO 3D shading, NO gradient.
```

## Examples

```bash
# Text to image, explicit output path
npx @the-focus-ai/nano-banana \
  "Minimalist app icon for a note-taking app: a single folded paper corner, teal on off-white, flat vector, centred, generous padding" \
  --output images/icon.png

# Edit an existing image
npx @the-focus-ai/nano-banana "make the sky purple and add distant hills" \
  --file original.png --output images/edited.png

# Fast draft, then a slower final pass
npx @the-focus-ai/nano-banana "a cute cartoon cat sticker, thick outline" --flash --output images/draft.png
npx @the-focus-ai/nano-banana "a cute cartoon cat sticker, thick outline, clean vector, high detail" --output images/final.png
```

## Iterating

Refinement beats re-rolling. Generate once, then edit the result:

```bash
npx @the-focus-ai/nano-banana "mountain sunset" --output v1.png
npx @the-focus-ai/nano-banana "make the sunset colours more vibrant, warmer highlights" --file v1.png --output v2.png
npx @the-focus-ai/nano-banana "add faint mist in the valley" --file v2.png --output v3.png
```

Keep each step in a new `--output` file so the earlier version is not lost.

## Rules

- **Always pass `--output`.** The default drops a timestamped file in `output/`,
  which is easy to lose and awkward to reference afterwards.
- **`--file` must be an image.** The CLI checks the MIME type and exits 1 on a
  non-image; PNG and JPEG are safe.
- **Quote the prompt.** It is one shell argument; unquoted newlines and `#`
  will change what the model receives.
- **Check the saved path.** The CLI prints it; then confirm the file exists and
  is non-empty (`ls -l <path>`) before telling the user it worked.
- **Cost and time.** Image generation is a paid API call and takes seconds to a
  minute. Do not loop over many variations without being asked.
- **No secrets in prompts.** Prompts are sent to a third-party API.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `GEMINI_API_KEY environment variable is not set` | Key missing | Add it to `.env` or the environment |
| `File not found at <path>` | Bad `--file` | Check the path; the CLI exits before calling out |
| `Input file ... is not an image` | Non-image passed to `--file` | Convert it first |
| `No image in response.` | Model returned text (often a refusal) | Read the printed response, adjust the prompt |
| `Cannot use both --prompt and --prompt-file` | Both supplied | Use one |
| `--video` missing | Video needs the sibling skill | See the `generate_video` skill |
