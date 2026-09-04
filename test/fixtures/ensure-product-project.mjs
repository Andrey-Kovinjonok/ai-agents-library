import { ensureProductProject } from "../../src/project-locations.js";

const [project, agentsRoot, homeDir] = process.argv.slice(2);
const result = await ensureProductProject("codegraph", project, { agentsRoot, homeDir });
process.stdout.write(`${JSON.stringify(result)}\n`);
