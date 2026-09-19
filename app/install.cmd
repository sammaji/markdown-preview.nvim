@PowerShell -ExecutionPolicy Bypass -Command Invoke-Expression $('$args=@(^&{$args} %*);'+[String]::Join(';',(Get-Content '%~f0') -notmatch '^^@PowerShell.*EOF$')) & goto :EOF

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = "sammaji/markdown-preview.nvim"
$file = "markdown-preview-win.zip"

$releases = "https://api.github.com/repos/$repo/releases"

Write-Host Determining release to install
if ($args[0]) { $tag = $args[0] } else { $tag = $null; $cargo = "..\Cargo.toml"; if (Test-Path $cargo) { $m = Select-String -Path $cargo -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1; if ($m) { $tag = "v" + $m.Matches.Groups[1].Value } }; if (-not $tag) { $tag = (Invoke-WebRequest $releases | ConvertFrom-Json)[0].tag_name } }

$download = "https://github.com/$repo/releases/download/$tag/$file"
$name = $file.Split(".")[0]
$zip = "$name-$tag.zip"
$dir = "bin"

new-item -Name $dir -ItemType directory -Force

Write-Host Dowloading latest release
Invoke-WebRequest $download -Out $zip

Remove-Item $dir\* -Recurse -Force -ErrorAction SilentlyContinue

Write-Host Extracting release files
Expand-Archive $zip -DestinationPath $dir -Force

Remove-Item $zip -Force
Write-Host markdown-preview install completed.
