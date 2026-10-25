// PreToolUse hook for desktop_sequence. The tool refuses a medium/high batch unless
// the model passes confirm: true; this hook makes that confirm the person's, not the
// model's: a confirmed risky batch becomes a Claude Code permission prompt that lists
// every step. Low-risk batches, dry runs and unconfirmed risky batches (which the tool
// refuses by itself) pass silently.
import { assessRisk, describeStep } from '../src/plan.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input;
try {
	input = JSON.parse(raw).tool_input ?? {};
} catch {
	process.exit(0);
}
const steps = Array.isArray(input.steps) ? input.steps.filter((step) => step && typeof step === 'object') : [];
const { effective, flagged } = assessRisk(steps, input.risk);
if (effective === 'low' || input.confirm !== true || input.dryRun === true) process.exit(0);

const lines = steps.slice(0, 15).map(describeStep);
if (steps.length > 15) lines.push(`… and ${steps.length - 15} more`);
process.stdout.write(JSON.stringify({
	hookSpecificOutput: {
		hookEventName: 'PreToolUse',
		permissionDecision: 'ask',
		permissionDecisionReason: [`desk-pilot: ${effective}-risk batch on your real desktop (${flagged.length > 0 ? flagged.join(', ') : 'declared for the whole batch'}):`, ...lines].join('\n')
	}
}));
