<#
.SYNOPSIS
    Publish a branch to the GitHub mirror as a single squashed commit.

.DESCRIPTION
    GitHub is a published-release mirror, not a working remote. `origin`
    (shiftcloud) keeps the real per-commit history; GitHub only ever receives
    one squashed commit per publish, so the day-to-day working rhythm -- when a
    feature was started, how often it was amended, when comments were written --
    never leaves the private remote.

    Mirroring is branch-to-branch: `main` publishes to github/main,
    `AI_recognition` to github/AI_recognition. Branch names and publish cadence
    are therefore visible; only the per-commit history is not. PRs keep working.

    The squash is built with plumbing (`git commit-tree` on the source branch's
    tree), so nothing is ever checked out: publishing works with edits in flight
    and leaves the working tree untouched.

    What GitHub has seen per branch is tracked in refs/github-mirror/<branch>,
    a private ref namespace that deliberately does not appear in `git branch`.

.PARAMETER Branch
    Local branch to publish. Defaults to main.

.PARAMETER Message
    Commit message for the squashed commit. Required unless -Preview or -Status.

.PARAMETER Preview
    Read-only. Show which files would change on GitHub. Pushes nothing.

.PARAMETER Status
    Read-only. List every mirrored branch and whether it is current.

.PARAMETER Reset
    Cut the branch loose from its published history: force-push the squash as a
    fresh root commit, discarding that branch's existing history on GitHub.

.PARAMETER Remote
    Git remote to publish to. Defaults to github.
#>
[CmdletBinding(DefaultParameterSetName = 'Publish')]
param(
    [Parameter(ParameterSetName = 'Publish', Position = 0, Mandatory = $true)]
    [Parameter(ParameterSetName = 'Reset', Position = 0)]
    [string]$Message,

    [Parameter(ParameterSetName = 'Publish', Position = 1)]
    [Parameter(ParameterSetName = 'Preview', Position = 0)]
    [Parameter(ParameterSetName = 'Reset', Position = 1)]
    [string]$Branch = 'main',

    [Parameter(ParameterSetName = 'Preview', Mandatory = $true)]
    [switch]$Preview,

    [Parameter(ParameterSetName = 'Status', Mandatory = $true)]
    [switch]$Status,

    [Parameter(ParameterSetName = 'Reset', Mandatory = $true)]
    [switch]$Reset,

    [string]$Remote = 'github'
)

$ErrorActionPreference = 'Stop'

# git writes ordinary progress ("To https://github.com/...", "* [new branch]")
# to stderr, so a successful command still produces stderr output. Merging that
# into the success stream with 2>&1 turns each line into an ErrorRecord, which
# under $ErrorActionPreference = 'Stop' aborts the script even on exit code 0.
# Every git call therefore goes through this helper, which pins the preference
# back to Continue for the duration of the native call and judges success by
# $LASTEXITCODE alone -- the only reliable signal from a native executable.
# NOTE: $GitArgs is a single positional array, NOT ValueFromRemainingArguments.
# With remaining-argument binding PowerShell steals any token that looks like
# one of its own parameters -- "-p <sha>" was being swallowed whole, silently
# producing parentless (root) commits that GitHub then rejected as
# non-fast-forward. Always call as: Invoke-Git @('commit-tree', $tree, '-p', $base)
function Invoke-Git {
    param([Parameter(Mandatory = $true, Position = 0)][string[]]$GitArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & git @GitArgs 2>&1
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prev
    }
    # 2>&1 yields ErrorRecords for stderr lines; render them back to plain text.
    $text = ($out | ForEach-Object { $_.ToString() }) -join "`n"
    return [pscustomobject]@{ Output = $text.Trim(); ExitCode = $code }
}

# Resolve a rev to a full SHA, or $null when it does not exist.
function Resolve-Rev {
    param([string]$Rev)
    $r = Invoke-Git @('rev-parse', '--verify', '--quiet', $Rev)
    if ($r.ExitCode -ne 0 -or -not $r.Output) { return $null }
    return $r.Output
}

# Resolve the tree SHA of a rev. Kept separate so the ^{tree} peel syntax lives
# in exactly one place -- it is awkward to quote through just/PowerShell.
function Resolve-Tree {
    param([string]$Rev)
    $r = Invoke-Git @('rev-parse', '--verify', '--quiet', ($Rev + '^{tree}'))
    if ($r.ExitCode -ne 0 -or -not $r.Output) { return $null }
    return $r.Output
}

function Get-MirrorRef {
    param([string]$Name)
    return "refs/github-mirror/$Name"
}

function Assert-Remote {
    $r = Invoke-Git @('remote', 'get-url', $Remote)
    if ($r.ExitCode -ne 0) {
        throw "No git remote named '$Remote'. Configure it, or pass -Remote <name>."
    }
}

# ---------------------------------------------------------------- Status ----
if ($Status) {
    Assert-Remote
    Invoke-Git @('fetch', $Remote, '--quiet') | Out-Null

    $refs = (Invoke-Git @('for-each-ref', '--format=%(refname)', 'refs/github-mirror/')).Output
    if (-not $refs) {
        Write-Host "No branches published to $Remote yet."
        return
    }

    $rows = foreach ($ref in ($refs -split "`n" | Where-Object { $_ })) {
        $name = $ref -replace '^refs/github-mirror/', ''
        $publishedTree = Resolve-Tree $ref
        $localTree = Resolve-Tree $name

        $state = if (-not $localTree) {
            'local branch gone'
        }
        elseif ($localTree -eq $publishedTree) {
            'up to date'
        }
        else {
            'changes pending'
        }

        # Flag drift: someone pushed to the remote branch outside this script.
        $remoteSha = Resolve-Rev "$Remote/$name"
        $mirrorSha = Resolve-Rev $ref
        if ($remoteSha -and $remoteSha -ne $mirrorSha) {
            $state = 'REMOTE MOVED'
        }

        [pscustomobject]@{
            Branch    = $name
            Published = $mirrorSha.Substring(0, 7)
            State     = $state
        }
    }

    $rows | Format-Table -AutoSize
    return
}

# --------------------------------------------------------------- Resolve ----
Assert-Remote

$srcSha = Resolve-Rev $Branch
if (-not $srcSha) { throw "No such branch: $Branch" }

$srcTree = Resolve-Tree $Branch
$mirrorRef = Get-MirrorRef $Branch

# --------------------------------------------------------------- Preview ----
if ($Preview) {
    $base = Resolve-Rev $mirrorRef
    if (-not $base) { $base = Resolve-Rev "$Remote/$Branch" }

    if (-not $base) {
        Write-Host "$Remote/$Branch does not exist yet -- the first publish would create it with the entire tree of $Branch."
        return
    }

    if ((Resolve-Tree $base) -eq $srcTree) {
        Write-Host "Nothing to publish: $Remote/$Branch already has this exact tree."
        return
    }

    Write-Host "Files that would change on $Remote/${Branch}:`n"
    # Streamed straight to the console rather than through Invoke-Git: this is
    # the output the user reads, and it can be long.
    $ErrorActionPreference = 'Continue'
    & git diff --stat $base $srcSha
    if ($LASTEXITCODE -ne 0) { throw "git diff failed (exit $LASTEXITCODE)." }
    return
}

# ----------------------------------------------------------------- Reset ----
if ($Reset) {
    if (-not $Message) { $Message = "Import $Branch" }

    $remoteSha = Resolve-Rev "$Remote/$Branch"
    if ($remoteSha) {
        Write-Host "This will FORCE-PUSH over $Remote/$Branch (currently $($remoteSha.Substring(0,7))), discarding that branch's published history on GitHub." -ForegroundColor Yellow
    }

    # Parentless: a fresh root commit, no ancestry back to the old history.
    $commit = (Invoke-Git @('commit-tree', $srcTree, '-m', $Message)).Output
    if (-not $commit) { throw 'commit-tree failed' }

    $push = Invoke-Git @('push', $Remote, '--force', "${commit}:refs/heads/$Branch")
    if ($push.ExitCode -ne 0) { throw "Force-push failed:`n$($push.Output)" }

    Invoke-Git @('update-ref', $mirrorRef, $commit) | Out-Null
    Write-Host "Reset $Remote/$Branch to a single root commit $($commit.Substring(0,7))." -ForegroundColor Green
    return
}

# --------------------------------------------------------------- Publish ----
Invoke-Git @('fetch', $Remote, '--quiet') | Out-Null

$base = Resolve-Rev $mirrorRef
$remoteSha = Resolve-Rev "$Remote/$Branch"

# First publish of a branch that already exists remotely: parent onto the
# existing tip so the push fast-forwards and the old history stays below it.
if (-not $base) { $base = $remoteSha }

# Refuse to clobber work pushed outside this script.
if ($remoteSha -and $base -and $remoteSha -ne $base) {
    throw "$Remote/$Branch ($($remoteSha.Substring(0,7))) has moved since the last publish ($($base.Substring(0,7))). Reconcile before publishing, or use -Reset to overwrite it."
}

if ($base -and (Resolve-Tree $base) -eq $srcTree) {
    Write-Host "Nothing to publish: $Remote/$Branch already has this exact tree."
    return
}

$commit = if ($base) {
    (Invoke-Git @('commit-tree', $srcTree, '-p', $base, '-m', $Message)).Output
}
else {
    (Invoke-Git @('commit-tree', $srcTree, '-m', $Message)).Output
}
if (-not $commit) { throw 'commit-tree failed' }

# Push first, record second: a failed push must not advance the mirror ref,
# or the next publish would build on a commit GitHub never received.
$push = Invoke-Git @('push', $Remote, "${commit}:refs/heads/$Branch")
if ($push.ExitCode -ne 0) { throw "Push failed -- mirror ref not advanced, nothing recorded:`n$($push.Output)" }

Invoke-Git @('update-ref', $mirrorRef, $commit) | Out-Null
Write-Host "Published $($commit.Substring(0,7)) to $Remote/$Branch as a single commit." -ForegroundColor Green
