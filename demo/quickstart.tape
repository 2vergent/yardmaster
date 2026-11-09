# README hero GIF: zero to a running five-service bookshop.
# Render from the repo root:  vhs demo/quickstart.tape
# Needs: vhs (+ ttyd, ffmpeg), ym on PATH, ports 8080 and 10350 free.

Output demo/gifs/quickstart.gif
Output demo/videos/quickstart.mp4

Set Shell "pwsh"
Set FontSize 18
Set Width 1280
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type "Set-Location $env:TEMP; function prompt { 'PS> ' }; Remove-Item -Recurse -Force bookshop -ErrorAction SilentlyContinue; Clear-Host" Enter
Sleep 1s
Show

Type "ym init --example bookshop" Enter
Sleep 3s
Type "cd bookshop" Enter
Sleep 500ms

Type "ym setup" Enter
Sleep 6s
# Stack picker: keep the default (storefront).
Enter
Sleep 3s
# Environment picker: keep the default (dev).
Enter
Sleep 15s
# Tab-completion prompt: skip.
Type "n" Enter
Sleep 2s

Type "ym up" Enter
Sleep 12s

Type "ym status" Enter
Sleep 6s

Type "curl.exe -s localhost:8080/orders | ConvertFrom-Json | Format-Table" Enter
Sleep 6s
