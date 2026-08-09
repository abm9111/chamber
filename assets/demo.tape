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
Set Width 1180
Set Height 800
Set Padding 18
Set Theme "Builtin Dark"
Set TypingSpeed 40ms
Set PlaybackSpeed 1.0

# A clean prompt: no username, no host, no path from the machine that recorded it.
Hide
Type "export PS1='%F{green}$%f '; clear" Enter
Show

Sleep 800ms
Type "chamber try" Sleep 400ms Enter

# `chamber try` completes in under two seconds, so the sleeps here are for the
# reader, not the program. The first version slept 20s against a 1.67s run and
# spent 85% of a looping GIF on a frozen final frame — anyone landing on the
# README mid-loop saw a still image.
#
# This holds only long enough to read the drift, then loops back while the
# reader is still interested.
Sleep 5s
