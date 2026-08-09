# Recording for the README's demo GIF.
#
# Scripted rather than hand-recorded, so it can be regenerated when the output
# changes instead of quietly describing a version of Chamber that no longer
# exists — the same reason demos/ runs in CI.
#
#   brew install vhs && vhs assets/demo.tape
#
# Emits assets/chamber-try.gif. Commit the regenerated GIF with the change that
# altered the output.

Output assets/chamber-try.gif

Set Shell zsh
Set FontSize 16
Set Width 1100
Set Height 760
Set Padding 18
Set Theme "Builtin Dark"
Set TypingSpeed 40ms
Set PlaybackSpeed 1.0

# A clean prompt: no username, no host, no path from the machine that recorded it.
Hide
Type "export PS1='%F{green}$%f '; clear" Enter
Show

Sleep 1s
Type "chamber try" Sleep 500ms Enter

# The run itself: ingest, search, believe, debt, pay-debt, verify clean.
Sleep 12s

# Then the announced edit and the drift. This is the beat worth landing, so it
# holds long enough to read the hash_mismatch rather than scrolling past it.
Sleep 8s
