# README GIF: feature branches across repos, environments, and stacks.
# Run after quickstart.tape, with the bookshop stack still up:
#   vhs demo/branches.tape

Output demo/gifs/branches.gif
Output demo/videos/branches.mp4

Set Shell "pwsh"
Set FontSize 18
Set Width 1280
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type "Set-Location $env:TEMP\bookshop; function prompt { 'PS> ' }; Clear-Host" Enter
Sleep 1s
Show

Type "ym checkout orders-api=feature/discounts shop-web=feature/discounts" Enter
Sleep 5s

Type "ym env staging" Enter
Sleep 4s

Type "ym stack save discounts --with-branches --with-env" Enter
Sleep 3s

Type "ym switch main" Enter
Sleep 8s

Type "ym stack apply discounts" Enter
Sleep 25s

Type "ym status" Enter
Sleep 8s

Type "curl.exe -s localhost:8080/orders | ConvertFrom-Json | Format-Table customer, book, discountPct, total" Enter
Sleep 6s
