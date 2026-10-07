# Add to ~/.config/fish/config.fish: pi-remote completion fish | source
# Or save this output as ~/.config/fish/completions/pi-remote.fish.
# No eval: completed words and the unfinished token are passed as arguments.
function __pi_remote_complete
    # -o preserves remote ~ instead of expanding it to the LOCAL home directory.
    # It also removes quoting from completed words without command substitution.
    set -l words (commandline -opc)
    set -l current (commandline -ct)
    command $words[1] complete --shell fish --raw-current -- $words[2..-1] "$current" 2>/dev/null
end
# Reloading config.fish must not register duplicate remote completion requests.
if not complete -c pi-remote | string match --quiet '*__pi_remote_complete*'
    complete -c pi-remote -f -a '(__pi_remote_complete)'
end
