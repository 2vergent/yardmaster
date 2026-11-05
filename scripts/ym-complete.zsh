# ym completion for zsh.
#
# Easiest install (auto-detects shell, writes the file, edits ~/.zshrc):
#   ym completion install
#
# Manual install:
#   ym completion zsh > ~/.ym-complete.zsh
#   echo 'source ~/.ym-complete.zsh' >> ~/.zshrc

_ym() {
    local -a commands services targets profiles
    local cur prev cmd
    cur="${words[CURRENT]}"
    prev="${words[CURRENT-1]}"
    cmd="${words[2]}"

    if (( CURRENT == 2 )); then
        commands=("${(@f)$(ym _complete commands 2>/dev/null)}")
        compadd -- $commands
        return
    fi

    case "$cmd" in
        up|add|remove|logs|restart|shell|code|deps|install|i)
            services=("${(@f)$(ym _complete services --active 2>/dev/null)}")
            compadd -- $services
            ;;
        status)
            compadd -- --routes -r
            ;;
        open)
            targets=("${(@f)$(ym _complete open-targets 2>/dev/null)}")
            compadd -- $targets
            ;;
        switch|sync)
            local branches
            branches=("${(@f)$(ym _complete branches 2>/dev/null)}")
            compadd -- $branches
            ;;
        env)
            local envs
            envs=("${(@f)$(ym _complete envs 2>/dev/null)}")
            compadd -- $envs
            ;;
        completion)
            compadd -- bash zsh pwsh install
            ;;
        stack)
            local stx
            if (( CURRENT == 3 )); then
                compadd -- list show apply create edit save delete
            elif [[ "$prev" == "apply" || "$prev" == "delete" || "$prev" == "rm" || "$prev" == "edit" || "$prev" == "--from" ]]; then
                stx=("${(@f)$(ym _complete stacks 2>/dev/null)}")
                compadd -- $stx
            fi
            ;;
    esac
}
compdef _ym ym
