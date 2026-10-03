---
name: genimg
description: Generate or edit images with the local codex CLI's image tool (ChatGPT login, no API key) and save them as PNGs — one or many pictures, variants, edits of an existing picture, transparent backgrounds. Use whenever the user asks to generate, draw, make or change a picture, icon, illustration, poster or texture — "生图", "画一张", "生成图片", "改图", "把这张图…", "用 codex 画" — and when a genimg run printed DRIFT or the user says "repair genimg" / "修复 genimg".
allowed-tools: PowerShell Read Edit Grep
---

# genimg

The wrapper is `genimg.ps1`, beside this file. The commands below write it as
`$env:USERPROFILE\.claude\skills\genimg\genimg.ps1`, where a user-level install
puts it; if this skill sits somewhere else, use that folder instead.

All pictures of a request go through the wrapper in ONE call, which is one
codex session. Do not call `codex exec` by hand, and do not make one call per
picture: the image quota is rate-limited, and every extra session costs codex
about 35k tokens of overhead.

```powershell
# one picture
& "$env:USERPROFILE\.claude\skills\genimg\genimg.ps1" -Prompt '<what to draw>' -Out '<absolute path>.png'

# several different pictures: prompts and paths pair up in order
& "$env:USERPROFILE\.claude\skills\genimg\genimg.ps1" -Prompt '<first>','<second>','<third>' -Out '<a>.png','<b>.png','<c>.png'

# several takes on one prompt: writes fox-1.png … fox-4.png
& "$env:USERPROFILE\.claude\skills\genimg\genimg.ps1" -Prompt '<what to draw>' -Out '<dir>\fox.png' -Count 4

# change an existing picture (also the way to follow up on one made earlier)
& "$env:USERPROFILE\.claude\skills\genimg\genimg.ps1" -Edit '<picture>.png' -Prompt '<what to change>' -Out '<new path>.png'
```

- Before calling, gather everything the user wants drawn in this request into
  one list. If they are likely to want more (a set of icons, variants to choose
  from), ask for them in the same call rather than coming back for a second.
- Run it with the PowerShell tool, `run_in_background: true`. Pictures are
  drawn one after another, about 60 s each; wait for the completion notice, do
  not poll.
- codex looks at each result itself and redraws until it matches its prompt;
  how many rounds is codex's own call. Leave it that way unless the user asks
  to save quota: `-Tries <n>` caps the draws per picture and `-NoCheck` turns
  the looking off. So do not Read the PNGs afterwards unless the user asks for
  them to be checked or the next step depends on what they show: viewing costs
  the user more than codex's own check.
- It prints `OK <path> <W>x<H> <n>KB` per picture (`MISS <path>` for one that
  never came out), then
  `DONE <made>/<asked> drawn=<n> <n>s tokens=<n> codex 5h=<n>% week=<n>% model=<m> effort=<e>`
  (`drawn` counts redraws too; the percentages are codex's own usage meters),
  or `FAIL <reason> log=<folder>`. Relay the paths, `drawn` and the two
  percentages. Read the log folder only on FAIL or DRIFT.
- "Make it bigger", "same but blue", "remove the text": use `-Edit` on the
  picture made earlier, with only the change as the prompt; the rest of the
  picture is kept. Several prompts with one `-Edit` give several edited
  versions of the same original. The original is never overwritten.
- `-Transparent` asks for a real alpha background on every picture of the
  call; the `OK` line then ends in `alpha`, or `opaque` if it did not work.
- `-Ref a.png,b.png` attaches pictures as style, composition or subject
  references (with `-Edit`: material to insert). `-Size '1536x1024'` or a
  ratio such as `16:9` is a request, not exact pixel control. Both apply to
  every picture of the call.
- `-Out` must end in `.png`. In a project, save under the project; with no
  project, ask where. An existing file needs `-Force`.
- `-PromptFile x.txt` (UTF-8, prompts parted by a line holding only `---`) for
  long prompts; `-TimeoutSec`.
- Write the prompts in English, each complete on its own: subject, style,
  background, palette, "no text" when none is wanted. Text the picture must
  show goes in double quotes in its own language, unchanged ("欢迎光临").
  A `'` inside a single-quoted prompt is written `''`.
- Not available on this path (they need an API key): masks, exact pixel size,
  quality level, output formats other than PNG.

## Model and effort

The codex model that directs the drawing and its reasoning effort default to
`genimg.json` beside the wrapper (`model` blank = whatever codex's own config
names; with no file, the effort is `low`). The user changes them with
`/genimg-set` (a mod command that runs without the model: alone it opens a list
of codex's models, then of the picked model's efforts; `/genimg-set <model>
<effort>` sets them directly) or by editing the file; do not edit the file
unless they ask. For one call only, pass `-Effort <level>` or `-Model <slug>`.
Never `ultra`: it hands the work to sub-agents, whose pictures the wrapper
cannot follow. The image model itself cannot be chosen on this path.

## When codex changes under it: DRIFT

The wrapper reads codex's session record, a format codex may change in any
update, and checks it on every run against the picture store. When they
disagree it still delivers the pictures (taken from the store by time), then
prints

```
DRIFT <what did not hold> codex=<verified>-><now> log=<folder>
```

exits with code 2 and keeps the finding in `genimg.state.json` beside the
wrapper until a run checks out again. A `FAIL … codex=<verified>-><now>` line
is the same finding when nothing could be delivered (a renamed flag, say).

On DRIFT, or such a FAIL, or when the user says "repair genimg" / "修复 genimg"
(the wording `/genimg-set` shows them), or when the genimg-set mod sends "The
genimg self-test did not pass" (it does by itself after a `/genimg-set test`
that found the script broken, with the script's lines below it):

1. Hand over the pictures that did come out, and tell the user in one line
   that genimg no longer matches this codex version and that you are fixing it.
2. Find what changed. The log folder holds `prompt.txt`, `err.log`, `out.log`,
   `last.txt` (codex's closing reply) and `record.txt` (the path of the session
   record). The reasons name the part:
   - `record`: no `rollout-*.jsonl` under `<codex home>\sessions` mentions the
     work folder's name in its first 12 lines.
   - `pictures:record=N/store=M`: the record's picture lines are not found. The
     wrapper looks for lines holding `"kind":"image_gen.generation"` and, in
     their last 1500 characters, `"savedPath":"…"`, `"started_at_ms":…`,
     `"completed_at_ms":…`. Grep the record for `savedPath` / `generated_images`
     / the PNG's file name to see what those lines look like now. The record's
     lines are megabytes long (they embed the picture): Grep with `-o` and a
     bounded pattern, never Read the file.
   - `limits`: no line under 6000 characters has `"rate_limits"` with
     `"primary":{"used_percent":…` and `"secondary":{"used_percent":…`.
   - `tokens`: neither log has `tokens used` followed by a number.
   - `fail`: codex itself refused; `err.log` and `codex exec --help` say which
     flag changed.
3. Change only `genimg.ps1` (keep it ASCII: PowerShell 5.1 reads it as ANSI),
   and this file where its description of the wrapper changed.
4. Verify with `genimg.ps1 -SelfTest` (one throwaway picture). It must end in
   `DONE` with no `DRIFT`; that also clears the state file.
5. Tell the user what codex changed, what you changed, and that the self-test
   passed.

Do not repair by loosening a check until it passes: a check that cannot be
made to hold again is removed outright and the user told what is no longer
verified.
