# ym completion for bash.
#
# Easiest install (auto-detects shell, writes the file, edits ~/.bashrc):
#   ym completion install
#
# Manual install:
#   ym completion bash > ~/.ym-complete.bash
#   echo 'source ~/.ym-complete.bash' >> ~/.bashrc

_ym_complete() {
    local cur prev cmd
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    cmd="${COMP_WORDS[1]}"

    if [ "$COMP_CWORD" -eq 1 ]; then
        local commands
        commands=$(ym _complete commands 2>/dev/null)
        COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
        return 0
    fi

    case "$cmd" in
        up|add|remove|logs|restart|shell|code|deps|install|i)
            local services
            services=$(ym _complete services --active 2>/dev/null)
            COMPREPLY=( $(compgen -W "$services" -- "$cur") )
            ;;
        status)
            COMPREPLY=( $(compgen -W "--routes -r" -- "$cur") )
            ;;
        open)
            local targets
            targets=$(ym _complete open-targets 2>/dev/null)
            COMPREPLY=( $(compgen -W "$targets" -- "$cur") )
            ;;
        switch|sync)
            local branches
            branches=$(ym _complete branches 2>/dev/null)
            COMPREPLY=( $(compgen -W "$branches" -- "$cur") )
            ;;
        env)
            local envs
            envs=$(ym _complete envs 2>/dev/null)
            COMPREPLY=( $(compgen -W "$envs" -- "$cur") )
            ;;
        completion)
            COMPREPLY=( $(compgen -W "bash zsh pwsh install" -- "$cur") )
            ;;
        stack)
            if [ "$COMP_CWORD" -eq 2 ]; then
                COMPREPLY=( $(compgen -W "list show apply create edit save delete" -- "$cur") )
            elif [ "$prev" = "apply" ] || [ "$prev" = "delete" ] || [ "$prev" = "rm" ] || [ "$prev" = "edit" ]; then
                local stx
                stx=$(ym _complete stacks 2>/dev/null)
                COMPREPLY=( $(compgen -W "$stx" -- "$cur") )
            elif [ "$prev" = "--from" ]; then
                local stx
                stx=$(ym _complete stacks 2>/dev/null)
                COMPREPLY=( $(compgen -W "$stx" -- "$cur") )
            fi
            ;;
    esac
    return 0
}
complete -F _ym_complete ym
