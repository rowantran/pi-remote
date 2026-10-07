# Install: source a file produced by `pi-remote completion bash`.
_pi_remote_complete() {
    local candidate current="${COMP_WORDS[COMP_CWORD]}"
    COMPREPLY=()
    # Passing the line as DATA avoids COMP_WORDS splitting --cwd=/path at '='.
    # The CLI only removes shell quotes; it never evaluates shell expressions.
    while IFS= read -r candidate; do
        COMPREPLY+=("$candidate")
    done < <(command "${COMP_WORDS[0]}" complete --shell bash \
        --line "${COMP_LINE:0:COMP_POINT}" --current-word "$current" 2>/dev/null)
    if type compopt >/dev/null 2>&1 && [[ ${COMPREPLY[0]} == */ ]]; then
        compopt -o nospace 2>/dev/null
    fi
    return 0
}
# filenames asks Readline to quote spaces/metacharacters, not to list local files.
complete -o filenames -F _pi_remote_complete pi-remote
