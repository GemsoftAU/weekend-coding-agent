---
name: big_text
description: Render large ASCII-art banner text with figlet, including a font showcase, width control and right-to-left options.
---

# Big Text (figlet)

Render text as large ASCII art. Use this when the user asks for a banner, big
letters, ASCII art, a title screen, or "make it say X in big letters". Do not
hand-draw ASCII art: figlet is installed and already has the fonts.

## Requirements

- `figlet` on `PATH`. Check with `figlet -v` (prints the banner and version).
- The fonts listed below are installed under `/usr/share/figlet` (the default
  `FIGLET_FONTDIR`). `figlet -I2` prints the directory it searches.

## Basic usage

Always quote the message. Unquoted, the shell splits it into several arguments
(and eats punctuation it treats specially), so `figlet HELLO WORLD` is not the
same input as `figlet "HELLO WORLD"`.

```bash
figlet "HELLO WORLD"
```

Gotcha: figlet word-wraps against the output width (80 columns by default) and
starts a new block when the next word does not fit. If a long line came out
stacked, either raise the width with `-w` or render fewer words per call.

### Useful flags

Source of truth: the figlet(6) man page, v2.2.5. Flags are read left to right
and the last one that touches a setting wins.

| Flag | Effect |
| --- | --- |
| `-f <font>` | Pick the font (see the showcase below) |
| `-w <n>` | Output width in columns (default 80); figlet wraps and centres against it |
| `-t` | Set the output width to the current **terminal** width (not "trim") |
| `-c` / `-l` / `-r` | Center / flush-left / flush-right justification |
| `-k` | Kerning: remove as many blanks as possible so glyphs touch, without smushing |
| `-s` | Smushing (the default): overlap and merge sub-characters per the font's layout mode |
| `-S` | Force smushing even on fonts that default to kerning/full width |
| `-W` | Full width: every FIGcharacter at its own full width, no kerning or smushing |
| `-p` | Paragraph mode: join line breaks inside a paragraph as if they were blanks |
| `-n` | Normal newline handling (the default): every newline produces a line break |
| `-R` / `-L` / `-X` | Right-to-left / left-to-right / follow the font's own direction |
| `-x` | Default justification: flush-left for LTR text, flush-right for RTL |
| `-I<n>` | Print one fact and exit: `-I2` font directory, `-I3` font, `-I4` width |
| `-d <dir>` | Use a different font directory |

Two common traps:

- **There is no `-h` help flag** in figlet 2.2.5: `figlet -h` prints
  `invalid option -- 'h'` and the usage line. Read the man page instead.
- **`-t` is a width flag, not a trim flag.** Use `-w <n>` when you want a
  specific width regardless of the terminal.

## Font showcase

Each block below was produced by `figlet -f <font> "HI"` on this machine. Pick
the font that matches the mood the user asked for, and prefer the ones below
over inventing a name: an uninstalled font makes figlet print an error to
stderr and fall back to nothing useful.

### Standard and clean

`standard` — the default, readable at any size:

```
 _   _ ___
| | | |_ _|
| |_| || |
|  _  || |
|_| |_|___|
```

`big` — taller, heavier, good for title screens:

```
 _    _ _____
| |  | |_   _|
| |__| | | |
|  __  | | |
| |  | |_| |_
|_|  |_|_____|
```

`small` — compact, still readable in a narrow terminal:

```
 _  _ ___
| || |_ _|
| __ || |
|_||_|___|
```

`mini` — tiny; the cheapest font if the banner must fit in a fixed box:

```
    _     _
|_||_| | / \
| ||_|_|_\_/
```

`banner` — dense `#` blocks, prints large and ink-heavy:

```
#     # ###
#     #  #
#     #  #
#######  #
#     #  #
#     #  #
#     # ###
```

`term` — no art at all, prints the plain text (handy as a "no font" fallback):

```
HI
```

### Slanted and script

`slant` — italic feel, the most common choice for a header:

```
    __  ______
   / / / /  _/
  / /_/ // /
 / __  // /
/_/ /_/___/
```

`script` — connected cursive, elegant but less legible at small sizes:

```
 ,        _
/|   |   | |
 |___|   | |
 |   |\_ |/
 |   |/\_/\/
```

`lean` — very wide forward lean; needs a wide terminal (`-w 200`):

```
    _/    _/  _/_/_/_/  _/        _/          _/_/
   _/    _/  _/        _/        _/        _/    _/
  _/_/_/_/  _/_/_/    _/        _/        _/    _/
 _/    _/  _/        _/        _/        _/    _/
_/    _/  _/_/_/_/  _/_/_/_/  _/_/_/_/    _/_/
```

### 3D, shadow and block

`shadow` — drop shadow, gives depth without being solid:

```
 |   |_ _|
 |   |  |
 ___ |  |
_|  _|___|
```

`block` — heavy solid block letters; best with `-k` so letters stay separate:

```
_|    _|  _|_|_|
_|    _|    _|
_|_|_|_|    _|
_|    _|    _|
_|    _|  _|_|_|
```

### Mono and dingbat

`digital` — each letter boxed, like a segmented display:

```
+-+-+
|H|I|
+-+-+
```

`bubble` — rounded outlines:

```
  _   _
 / \ / \
( H | I )
 \_/ \_/
```

`ivrit` — right-to-left font (Latin glyphs are the `standard` ones, printed
mirrored). Use with `-R`. `mnemonic`, `smscript`, `smshadow`, `smslant` are also
installed; check one with `figlet -f <name> "HI"` before committing to it.

## Recipe: pick a font, keep it readable

```bash
# 1. Preview the message in a few candidate fonts before choosing.
for f in standard slant big shadow block; do
  echo "=== $f"
  figlet -f "$f" "YOUR TITLE"
done

# 2. Render the final banner to a file at a fixed width.
figlet -w 200 -f slant "YOUR TITLE" > banner.txt
cat banner.txt
```

Never end with a silent `figlet ... > file` and no check: `cat` the file so the
user (and you) can see what was written.

## Recipe: centred banner for a README

```bash
figlet -c -w 100 -f standard "PROJECT NAME"
```

`-c` centres each line inside the 100-column width, which keeps the art aligned
when pasted into a fixed-width block.

## Recipe: keep letters apart

Default output is smushed. When a font is hard to read because glyphs touch or
merge, switch to kerning or full width instead:

```bash
figlet -k -f block "HI"   # kerning: blank columns removed, glyphs never merge
figlet -W -f standard "HI"  # full width: widest and clearest, costs more columns
```

## Related commands

- `toilet` — a colourising variant of figlet. Do not assume it is installed;
  check with `command -v toilet` first.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `figlet: <font>: Unable to open font file` | Font not installed | Use a font from the showcase |
| Art breaks into several stacked blocks | Line does not fit in the output width | Raise `-w`, or render fewer words per call |
| Letters run together | Smushing is the default | Add `-k` (kern) or `-W` (full width) |
| Output has blank lines above/below | Rigid height of the font | Normal; keep it inside a fenced code block |
| `invalid option -- 'h'` | `-h` is not help in 2.2.5 | Read the figlet man page |
