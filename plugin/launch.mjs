// The file plugin.json runs. The work is in launcher.mjs so that a test can
// import it without starting a server: a check for "am I the main file" that
// guessed wrong would exit 0 and start nothing.
import { main } from "./launcher.mjs";

main();
