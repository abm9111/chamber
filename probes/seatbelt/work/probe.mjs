import { existsSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import dns from "node:dns/promises";
const out = {};
try { out.homeRead = readdirSync(homedir()).length > 0; } catch { out.homeRead = "BLOCKED"; }
try { out.sshRead = existsSync(homedir() + "/.ssh"); } catch { out.sshRead = "BLOCKED"; }
try { writeFileSync(homedir() + "/.sbtest_escape", "x"); out.homeWrite = true; }
catch { out.homeWrite = "BLOCKED"; }
try { writeFileSync("./inside.txt", "x"); out.workdirWrite = true; }
catch (e) { out.workdirWrite = "BLOCKED:" + e.code; }
try { const a = await dns.lookup("example.com"); out.net = "RESOLVED " + a.address; }
catch { out.net = "BLOCKED"; }
console.log(JSON.stringify(out, null, 2));
