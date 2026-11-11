# yardmaster Demo
# Comprehensive walkthrough: zero to a running 5-service fleet, live multi-repo branches,
# environments, stack bookmarking, diagnostics, and teardown.
#
# Render with: vhs demo/demo.tape

Output demo/gifs/demo.gif
Output demo/videos/demo.mp4

Set Shell "pwsh"
Set FontSize 18
Set Width 1280
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Hide
Type "Set-Location $env:TEMP; function prompt { 'PS> ' }; Remove-Item -Recurse -Force bookshop -ErrorAction SilentlyContinue; Clear-Host" Enter
Sleep 1s
Show

# 1. Initialize a runnable microservice fleet
Type "ym init --example bookshop" Enter
Sleep 3s
Type "cd bookshop" Enter
Sleep 500ms

# 2. One command to clone, install, and generate .env files
Type "ym setup" Enter
Sleep 6s
# Choose default stack (storefront)
Enter
Sleep 3s
# Choose default environment (dev)
Enter
Sleep 15s
# Skip shell completion prompt for now
Type "n" Enter
Sleep 2s

# 3. Spin up the whole fleet under Tilt with reverse-proxy gateway
Type "ym up" Enter
Sleep 12s

# 4. Check status across all services and routes
Type "ym status" Enter
Sleep 6s

# 5. Query the unified gateway on localhost:8080
Type "curl.exe -s localhost:8080/orders | ConvertFrom-Json | Format-Table" Enter
Sleep 5s

# 6. Branch switching across multiple repos + environment switch in 2 commands
Type "ym checkout orders-api=feature/discounts shop-web=feature/discounts" Enter
Sleep 4s
Type "ym env staging" Enter
Sleep 4s

# 7. Live changes reflected immediately through gateway (10% discount applied)
Type "curl.exe -s localhost:8080/orders | ConvertFrom-Json | Format-Table customer, book, discountPct, total" Enter
Sleep 5s

# 8. Bookmark fleet state (services + branches + env)
Type "ym stack save discounts --with-branches --with-env" Enter
Sleep 3s

# 9. Health & diagnostics check
Type "ym doctor" Enter
Sleep 5s

# 10. Clean shutdown
Type "ym down" Enter
Sleep 5s
