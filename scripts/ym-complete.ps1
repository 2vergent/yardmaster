# ym completion for PowerShell (5.1 / 7+).
#
# Easiest install (writes the file and edits your $PROFILE):
#   ym completion install
#
# Manual install:
#   ym completion pwsh | Out-File -Encoding utf8 "$HOME/.ym-complete.ps1"
#   # then add to your $PROFILE:
#   '. "$HOME/.ym-complete.ps1"' | Add-Content $PROFILE

Register-ArgumentCompleter -CommandName ym -Native -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $tokens = $commandAst.CommandElements | ForEach-Object { $_.Extent.Text }
    $tokenIndex = $tokens.Count - 1
    if ($wordToComplete -ne '' -and $tokens[-1] -eq $wordToComplete) {
        $tokenIndex--
    }

    $cmd  = if ($tokens.Count -ge 2) { $tokens[1] } else { '' }
    $prev = if ($tokens.Count -ge 2) { $tokens[$tokens.Count - 2] } else { '' }

    # Position 1 = first arg after `ym`
    if ($tokenIndex -lt 1) {
        $opts = (& ym _complete commands 2>$null) -split "`n" | Where-Object { $_ }
        return $opts |
            Where-Object { $_ -like "$wordToComplete*" } |
            ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
    }

    switch ($cmd) {
        { @('up','add','remove','logs','restart','shell','code','deps','install','i') -contains $_ } {
            $opts = (& ym _complete services --active 2>$null) -split "`n" | Where-Object { $_ }
        }
        'status' { $opts = @('--routes','-r') }
        'open' {
            $opts = (& ym _complete open-targets 2>$null) -split "`n" | Where-Object { $_ }
        }
        { @('switch','sync') -contains $_ } {
            $opts = (& ym _complete branches 2>$null) -split "`n" | Where-Object { $_ }
        }
        'env'        { $opts = (& ym _complete envs 2>$null) -split "`n" | Where-Object { $_ } }
        'completion' { $opts = @('bash','zsh','pwsh','install') }
        'stack'      {
            if ($tokenIndex -eq 2) {
                $opts = @('list','show','apply','create','edit','save','delete')
            } elseif (@('apply','delete','rm','edit','--from') -contains $prev) {
                $opts = (& ym _complete stacks 2>$null) -split "`n" | Where-Object { $_ }
            } else {
                $opts = @()
            }
        }
        default { $opts = @() }
    }

    return $opts |
        Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
