# One-time setup for the local Windows workshop.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $root
function Invoke-Checked([string]$program, [string[]]$arguments) {
    & $program @arguments
    if ($LASTEXITCODE -ne 0) { throw "$program failed with exit code $LASTEXITCODE" }
}
try {
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    Invoke-Checked 'node' @('-e', "if(Number(process.versions.node.split('.')[0])<24)throw Error('Install Node.js 24 or newer')")
    $python = Join-Path $root '.venv\Scripts\python.exe'
    if (!(Test-Path -LiteralPath $python)) {
        if ($env:AIRFORM_PYTHON) { Invoke-Checked $env:AIRFORM_PYTHON @('-m','venv','.venv') }
        else { Invoke-Checked 'py' @('-3.12','-m','venv','.venv') }
    }
    Invoke-Checked $python @('-c',"import sys,struct; assert sys.version_info[:2]==(3,12) and struct.calcsize('P')==8, 'Python 3.12 x64 required'")
    Invoke-Checked $python @('-m','pip','install','-r','requirements.txt')
    Invoke-Checked $python @('setup/fetch_assets.py')
    Invoke-Checked $python @('setup/prepare_astra_gpu.py')
    if ($env:OPENNI2_REDIST64 -and (Test-Path -LiteralPath (Join-Path $env:OPENNI2_REDIST64 'OpenNI2.dll'))) {
        Set-Content -LiteralPath (Join-Path $root '.cache/openni2-runtime.txt') -Value $env:OPENNI2_REDIST64 -Encoding UTF8
    }
    Invoke-Checked $npm @('--prefix','web','ci','--no-audit','--no-fund')
    Invoke-Checked $npm @('--prefix','web','run','build')
    foreach ($asset in @('index.html','astra-python-ready.svg','tracking-worker.js','assets/hand_landmarker.task')) {
        if (!(Test-Path -LiteralPath (Join-Path $root "web/dist/$asset"))) { throw "Missing built asset: $asset" }
    }
    Invoke-Checked $python @('backend/workshop_launcher.py','--register')
    Write-Host 'AIRFORM Astra Python is ready. Double-click AIRFORM.html.'
} finally { Pop-Location }
