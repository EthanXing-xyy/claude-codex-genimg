<#
.SYNOPSIS
  Pictures from the local codex CLI (ChatGPT login, no API key), saved where asked.
  Any number of pictures are drawn, or one picture edited, in ONE codex session.

.DESCRIPTION
  Prints one line per picture and a closing line, nothing else:
    OK <path> <W>x<H> <n>KB [alpha|opaque]
    MISS <path>
    DONE <made>/<asked> drawn=<n> <n>s tokens=<n> codex 5h=<n>% week=<n>% model=<m> effort=<e>
  after them, when codex no longer behaves the way this script was verified with:
    DRIFT <what did not hold> codex=<verified>-><now> log=<folder>
  or, when nothing can be delivered:
    FAIL <reason> log=<folder>

  codex draws, looks at each result and redraws until it matches its description
  (how many rounds is codex's own call, unless -Tries caps the draws per picture);
  this script reads the session record to learn which file is which picture and
  copies them out. Runs queue up behind each other.

  The record is codex's own format and may change with any codex update, so
  every run checks it against the picture store. When they disagree the pictures
  are taken from the store by time instead, DRIFT is printed, the exit code is 2
  and genimg.state.json keeps the finding until a run checks out again.

  Defaults for -Model and -Effort are read from genimg.json beside this script
  (/genimg-set in Claude Code edits it).

  The work folder of a run (prompt, logs) is made under $env:GENIMG_TMP, or
  under the system temp folder when that is not set; it is deleted when the run
  checks out and kept on FAIL or DRIFT.

.EXAMPLE
  .\genimg.ps1 -Prompt 'a red paper lantern, flat vector' -Out D:\proj\art\lantern.png

.EXAMPLE
  .\genimg.ps1 -Prompt 'a red lantern','a blue kite','a green frog' -Out a.png,b.png,c.png

.EXAMPLE
  .\genimg.ps1 -Prompt 'a fox mascot, sticker style' -Out fox.png -Count 4 -Transparent   # fox-1.png .. fox-4.png

.EXAMPLE
  .\genimg.ps1 -Edit frog.png -Prompt 'give the frog a small red party hat' -Out frog-hat.png

.EXAMPLE
  .\genimg.ps1 -SelfTest    # one throwaway picture through every check
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string[]]$Prompt = @(),
  [Parameter(Position = 1)][string[]]$Out = @(),
  [string]$PromptFile = '',
  [int]$Count = 0,
  [string]$Edit = '',
  [string[]]$Ref = @(),
  [string]$Size = '',
  [switch]$Transparent,
  [int]$Tries = 0,
  [switch]$NoCheck,
  [string]$Model = '',
  [string]$Effort = '',
  [int]$TimeoutSec = 0,
  [switch]$SelfTest,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$settingsFile = Join-Path $PSScriptRoot 'genimg.json'
$stateFile = Join-Path $PSScriptRoot 'genimg.state.json'

# set once codex has run: from then on a failure may be codex having changed
$script:work = ''
$script:verified = ''
$script:current = ''

function Read-Json([string]$Path) {
  try { return ConvertFrom-Json ([IO.File]::ReadAllText($Path, $utf8)) } catch { return $null }
}

function Save-State([string]$Verified, $Drift) {
  $state = [ordered]@{ verified = $Verified; drift = $Drift }
  [IO.File]::WriteAllText($stateFile, (ConvertTo-Json $state -Depth 4), $utf8)
}

# what codex itself said went wrong: its first error line, else its last line
function Get-Complaint([string]$File) {
  if (-not (Test-Path -LiteralPath $File)) { return '' }
  $said = @([IO.File]::ReadAllLines($File) | Where-Object { $_.Trim() -ne '' })
  $line = $said | Where-Object { $_ -match '^\s*error\b' } | Select-Object -First 1
  if ($null -eq $line) { $line = $said | Select-Object -Last 1 }
  if ($null -eq $line) { return '' }
  $line = $line.Trim()
  if ($line.Length -gt 200) { $line = $line.Substring(0, 200) }
  return $line
}

function Stop-Failed([string]$Reason) {
  $line = "FAIL $Reason"
  if ($script:work -ne '') {
    $last = Get-Complaint (Join-Path $script:work 'err.log')
    if ($last -ne '') { $line += " | codex: $last" }
    if ($script:current -ne $script:verified) {
      # a failure on a codex version never seen working: most likely the update
      $line += " codex=$($script:verified)->$($script:current)"
      Save-State $script:verified ([ordered]@{
          since = (Get-Date).ToString('s'); codex = $script:current; reasons = @('fail'); log = $script:work
        })
    }
    $line += " log=$($script:work)"
  }
  Write-Output $line
  exit 1
}

function Resolve-Full([string]$Path) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Test-Mentions([string]$File, [string]$Word) {
  $seen = 0
  foreach ($line in [IO.File]::ReadLines($File)) {
    if ($line.Contains($Word)) { return $true }
    $seen += 1
    if ($seen -ge 12) { break }
  }
  return $false
}

# --- settings -------------------------------------------------------------------

$settings = Read-Json $settingsFile
if ($Model -eq '' -and $null -ne $settings -and $settings.model) { $Model = [string]$settings.model }
if ($Effort -eq '' -and $null -ne $settings -and $settings.effort) { $Effort = [string]$settings.effort }
if ($Effort -eq '') { $Effort = 'low' }

# an empty folder of its own: no project files for the agent to read, and its
# name is how this run's session record is told from any other
$tmp = if ($env:GENIMG_TMP) { $env:GENIMG_TMP } else { Join-Path ([IO.Path]::GetTempPath()) 'genimg' }
$work = Join-Path $tmp ('{0:yyyyMMdd-HHmmss}-{1}-{2}' -f (Get-Date), $PID, (Get-Random -Maximum 10000))

if ($SelfTest) {
  $Prompt = @('a single red circle on a plain white background, flat, no text')
  $Out = @(Join-Path $work 'selftest.png')
  $PromptFile = ''; $Count = 0; $Edit = ''; $Ref = @(); $Size = ''
  $Transparent = $false; $NoCheck = $true
}

# --- what to draw, and where each picture goes ---------------------------------

$asks = @($Prompt | Where-Object { $_.Trim() -ne '' })
if ($PromptFile -ne '') {
  # one prompt per block, blocks parted by a line holding only ---
  $text = [IO.File]::ReadAllText((Resolve-Full $PromptFile), $utf8)
  $asks = @([regex]::Split($text, '(?m)^\s*---\s*$') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}
if ($asks.Count -eq 0) { Stop-Failed 'no prompt' }
if ($Out.Count -eq 0) { Stop-Failed 'no -Out path' }

$isVariants = $Count -gt 1
if ($isVariants) {
  if ($asks.Count -ne 1 -or $Out.Count -ne 1) { Stop-Failed '-Count takes one prompt and one -Out' }
  $base = Resolve-Full $Out[0]
  $stem = Join-Path (Split-Path -Parent $base) ([IO.Path]::GetFileNameWithoutExtension($base))
  $targets = @(1..$Count | ForEach-Object { "$stem-$_$([IO.Path]::GetExtension($base))" })
  $asks = @(1..$Count | ForEach-Object { $asks[0] })
}
else {
  if ($asks.Count -ne $Out.Count) { Stop-Failed "$($asks.Count) prompts but $($Out.Count) -Out paths" }
  $targets = @($Out | ForEach-Object { Resolve-Full $_ })
}

foreach ($one in $targets) {
  if ([IO.Path]::GetExtension($one) -ne '.png') { Stop-Failed 'the pictures are PNGs: -Out must end in .png' }
  if ((Test-Path -LiteralPath $one) -and -not $Force) { Stop-Failed "$one exists (pass -Force to replace it)" }
}
if (@($targets | Select-Object -Unique).Count -ne $targets.Count) { Stop-Failed 'two pictures share one -Out path' }

$isEdit = $Edit -ne ''
$attached = @()
if ($isEdit) { $attached += Resolve-Full $Edit }
$attached += @($Ref | ForEach-Object { Resolve-Full $_ })
foreach ($one in $attached) {
  if (-not (Test-Path -LiteralPath $one)) { Stop-Failed "picture not found: $one" }
}

$asked = $targets.Count
# 0 leaves the number of redraws to codex; 1 is no checking at all
$Tries = [Math]::Max(0, $Tries)
if ($NoCheck) { $Tries = 1 }
if ($TimeoutSec -le 0) {
  $TimeoutSec = if ($Tries -gt 0) { 300 + 120 * $asked * $Tries } else { 900 + 300 * $asked }
}

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$store = Join-Path $codexHome 'generated_images'

$state = Read-Json $stateFile
$verified = if ($null -ne $state -and $state.verified) { [string]$state.verified } else { '' }
$current = ''
try { $current = ([string](& codex --version | Select-Object -First 1)) -replace '^\S+\s+', '' } catch { }
if ($current -eq '') { Stop-Failed 'codex is not on PATH' }

[void](New-Item -ItemType Directory -Force -Path $work)

# --- the instructions codex gets ------------------------------------------------

$lines = @()
if ($isEdit) {
  $lines += "Attached picture 1 is the picture to edit. Make the $asked edited version(s) of it listed below with the image generation tool, all in this one turn."
  $lines += 'Every version starts from attached picture 1: change only what its item asks for and keep everything else as it is - subject, composition, framing, colours, style.'
  if ($attached.Count -gt 1) { $lines += 'The other attached pictures are material for the edits (things to insert, or a style to follow), not pictures to edit.' }
}
else {
  $lines += "Make the $asked picture(s) listed below with the image generation tool, all in this one turn."
  if ($attached.Count -gt 0) { $lines += 'The attached pictures are references for all of them (style, composition or subject), not pictures to edit.' }
}
$lines += 'One tool call per picture, in the listed order, each call awaited before the next one starts: never in parallel, and never handed to another agent.'
$lines += 'Do not merge, skip or add pictures. Text a picture must show is given in quotes: render it exactly, character for character.'
if ($isVariants) { $lines += 'The descriptions are the same on purpose: make each picture a clearly different take on it.' }
if ($Transparent) { $lines += 'Every picture needs a genuinely transparent background: ask the tool for it (transparent_background: true).' }
if ($Size -ne '') { $lines += "Size of every picture: $Size" }
if ($Tries -ne 1) {
  $lines += "After each call, look at the result and judge it against its item: subject, style, composition, quoted text spelled exactly, things it says to avoid$(if ($isEdit) { ', and that the rest of the picture is unchanged' })."
  $lines += 'If it misses, call the tool again for that picture with a single targeted change and check again; go on to the next picture once it is right.'
  $lines += if ($Tries -eq 0) { 'How many rounds a picture takes is your call.' } else { "At most $($Tries - 1) redraw(s) per picture." }
}
else {
  $lines += 'Do not inspect the results and do not redraw; if a call fails outright, retry it once.'
}
$lines += 'Do not run shell commands and do not save or copy the files.'
$lines += 'When all are done, reply with one line per picture and nothing else: "PICTURE <n>: <k>", where <k> counts the images the tool has returned in this turn, in order from 1, and names the one to keep for picture <n> ("PICTURE <n>: none" if it never came out).'
$lines += ''
for ($i = 0; $i -lt $asked; $i++) { $lines += "Picture $($i + 1): $($asks[$i])" }

$askFile = Join-Path $work 'prompt.txt'
$replyFile = Join-Path $work 'last.txt'
[IO.File]::WriteAllText($askFile, ($lines -join "`n"), $utf8)

$codexArgs = @(
  'exec', '--skip-git-repo-check', '-s', 'read-only',
  '--enable', 'image_generation', '-c', "model_reasoning_effort=$Effort",
  '-C', "`"$work`"", '-o', "`"$replyFile`""
)
if ($Model -ne '') { $codexArgs += @('-m', $Model) }
foreach ($one in $attached) { $codexArgs += @('-i', "`"$one`"") }
# the prompt arrives on stdin; '-' also keeps it from being read as one more -i file
$codexArgs += @('--', '-')

# --- one codex session ----------------------------------------------------------

$gate = New-Object System.Threading.Mutex($false, 'genimg-codex')
try { [void]$gate.WaitOne() } catch [System.Threading.AbandonedMutexException] { }

try {
  $began = Get-Date
  $script:work = $work
  $script:verified = $verified
  $script:current = $current
  $run = Start-Process -FilePath 'codex' -ArgumentList ($codexArgs -join ' ') -NoNewWindow -PassThru `
    -RedirectStandardInput $askFile `
    -RedirectStandardOutput (Join-Path $work 'out.log') `
    -RedirectStandardError (Join-Path $work 'err.log')
  $null = $run.Handle

  if (-not $run.WaitForExit($TimeoutSec * 1000)) {
    & taskkill /PID $run.Id /T /F *> $null
    Stop-Failed "codex timed out after ${TimeoutSec}s"
  }
  $seconds = [int]((Get-Date) - $began).TotalSeconds
}
finally {
  $gate.ReleaseMutex()
  $gate.Dispose()
}

# --- which file is which picture: the session record says -----------------------

# what did not hold of the things this script relies on codex for
$unheld = @()

$record = Get-ChildItem -Path (Join-Path $codexHome 'sessions') -Recurse -Filter 'rollout-*.jsonl' -File -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -ge $began.AddSeconds(-5) } |
  Where-Object { Test-Mentions $_.FullName (Split-Path -Leaf $work) } |
  Select-Object -First 1

$drawn = @()
$limits = ''
if ($null -eq $record) {
  $unheld += 'record'
}
else {
  [IO.File]::WriteAllText((Join-Path $work 'record.txt'), $record.FullName, $utf8)
  foreach ($line in [IO.File]::ReadLines($record.FullName)) {
    if ($line.Length -lt 6000 -and $line.Contains('"rate_limits"')) {
      if ($line -match '"primary":\{"used_percent":([\d.]+).*?"secondary":\{"used_percent":([\d.]+)') {
        $limits = " codex 5h=$([int][double]$Matches[1])% week=$([int][double]$Matches[2])%"
      }
      continue
    }
    if (-not $line.Contains('"kind":"image_gen.generation"')) { continue }
    # the picture itself sits in the middle of the line; the facts are at its end
    $tail = $line.Substring([Math]::Max(0, $line.Length - 1500))
    if ($tail -match '"savedPath":("(?:[^"\\]|\\.)*").*"started_at_ms":(\d+),"completed_at_ms":(\d+)') {
      $drawn += [pscustomobject]@{
        Path  = ConvertFrom-Json $Matches[1]
        Start = [int64]$Matches[2]
        End   = [int64]$Matches[3]
      }
    }
  }
  if ($limits -eq '') { $unheld += 'limits' }
}
$drawn = @($drawn | Where-Object { Test-Path -LiteralPath $_.Path } | Sort-Object Path -Unique | Sort-Object Start)

# the store is the second witness: what the record names must be what this run
# left there (in the session's own folder, or anywhere when the record names none)
$folders = @($drawn | ForEach-Object { Split-Path -Parent $_.Path } | Select-Object -Unique)
if ($folders.Count -eq 0) { $folders = @($store) }
$stored = @(Get-ChildItem -Path $folders -Recurse -Filter *.png -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $began.AddSeconds(-2) } |
    Sort-Object LastWriteTime)
if ($stored.Count -ne $drawn.Count) {
  $unheld += "pictures:record=$($drawn.Count)/store=$($stored.Count)"
  $drawn = @($stored | ForEach-Object {
      [pscustomobject]@{ Path = $_.FullName; Start = $_.LastWriteTime.Ticks; End = $_.LastWriteTime.Ticks }
    })
}

if ($drawn.Count -eq 0) { Stop-Failed "codex drew nothing (exit $($run.ExitCode))" }
$kept = Split-Path -Parent $drawn[0].Path

# picture number -> which of the drawn files. One file per picture needs no
# telling; with redraws, or a picture missing, codex's closing lines decide.
$pick = @{}
if ($drawn.Count -eq $asked) {
  for ($i = 1; $i -le $asked; $i++) { $pick[$i] = $i }
}
else {
  $reply = if (Test-Path -LiteralPath $replyFile) { [IO.File]::ReadAllText($replyFile) } else { '' }
  foreach ($m in [regex]::Matches($reply, '(?im)^\s*PICTURE\s+(\d+)\s*:\s*(\d+)\s*$')) {
    $n = [int]$m.Groups[1].Value
    $k = [int]$m.Groups[2].Value
    if ($n -ge 1 -and $n -le $asked -and $k -ge 1 -and $k -le $drawn.Count) { $pick[$n] = $k }
  }
  if (@($pick.Values | Select-Object -Unique).Count -ne $pick.Count) { $pick = @{} }
  if ($pick.Count -eq 0) {
    Stop-Failed "codex drew $($drawn.Count) for $asked asked and did not say which to keep; they are left in $kept"
  }
}

$isParallel = $false
for ($i = 1; $i -lt $drawn.Count; $i++) {
  if ($drawn[$i].Start -lt $drawn[$i - 1].End) { $isParallel = $true }
}

Add-Type -AssemblyName System.Drawing
$made = 0
for ($n = 1; $n -le $asked; $n++) {
  $target = $targets[$n - 1]
  if (-not $pick.ContainsKey($n)) {
    Write-Output "MISS $target"
    continue
  }
  [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target))
  Copy-Item -LiteralPath $drawn[$pick[$n] - 1].Path -Destination $target -Force
  $picture = New-Object System.Drawing.Bitmap $target
  $extent = '{0}x{1}' -f $picture.Width, $picture.Height
  $clear = ''
  if ($Transparent) {
    $isClear = [System.Drawing.Image]::IsAlphaPixelFormat($picture.PixelFormat) -and $picture.GetPixel(0, 0).A -lt 255
    $clear = if ($isClear) { ' alpha' } else { ' opaque' }
  }
  $picture.Dispose()
  Write-Output ("OK $target $extent {0}KB$clear" -f [int]((Get-Item -LiteralPath $target).Length / 1KB))
  $made += 1
}

$spent = '?'
$said = [IO.File]::ReadAllText((Join-Path $work 'err.log')) + [IO.File]::ReadAllText((Join-Path $work 'out.log'))
if ($said -match '(?s)tokens used\D{0,20}([\d,]+)') { $spent = $Matches[1] -replace ',', '' }
if ($spent -eq '?') { $unheld += 'tokens' }

$note = if ($isParallel -and -not $isVariants) { ' (drawn in parallel: check which picture is which)' } else { '' }
$with = " model=$(if ($Model -ne '') { $Model } else { 'default' }) effort=$Effort"
Write-Output "DONE $made/$asked drawn=$($drawn.Count) ${seconds}s tokens=$spent$limits$with$note"

if ($unheld.Count -gt 0) {
  # the evidence stays: prompt, logs, codex's reply and where its record is
  Save-State $verified ([ordered]@{
      since = (Get-Date).ToString('s'); codex = $current; reasons = $unheld; log = $work
    })
  Write-Output "DRIFT $($unheld -join ',') codex=$verified->$current log=$work"
  exit 2
}

Save-State $current $null
Remove-Item -LiteralPath $work -Recurse -Force
if ($made -lt $asked) { exit 1 }
