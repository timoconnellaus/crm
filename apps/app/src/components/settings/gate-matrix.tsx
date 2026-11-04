// Read-only rendering of approval-policy rules: a preset's actor × risk matrix, and the
// deploy-time floor.
import {
  type Actor,
  type GateFloor,
  type GateMatrix,
  type GateRule,
  RISK_CLASSES,
} from "@crm/core/client";
import { Badge } from "@crm/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@crm/ui/components/table";

export const ACTOR_LABELS: Record<Actor | "*", string> = {
  human: "People (in the app)",
  assistant: "In-app AI assistant",
  mcp: "External AI (MCP)",
  automation: "Automations",
  "*": "Everyone",
};

const DECISION_STYLE = {
  auto: "secondary",
  review: "outline",
  deny: "destructive",
} as const;

export function RuleBadge({ rule }: { rule: GateRule }) {
  if (typeof rule === "string") {
    return <Badge variant={DECISION_STYLE[rule]}>{rule}</Badge>;
  }
  return (
    <Badge
      variant="outline"
      title={`Automatic for up to ${rule.autoUpTo} records, then ${rule.above}`}
    >
      auto ≤ {rule.autoUpTo}, then {rule.above}
    </Badge>
  );
}

/** The preset's matrix for non-human actors (people are always `auto`; roles still apply). */
export function GateMatrixTable({ matrix }: { matrix: GateMatrix }) {
  const actors: Actor[] = ["assistant", "mcp", "automation"];
  return (
    <Table aria-label="What each actor may do without review" data-testid="policy-matrix">
      <TableHeader>
        <TableRow>
          <TableHead>Risk</TableHead>
          {actors.map((actor) => (
            <TableHead key={actor}>{ACTOR_LABELS[actor]}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {RISK_CLASSES.map((risk) => (
          <TableRow key={risk}>
            <TableCell className="font-medium">{risk}</TableCell>
            {actors.map((actor) => (
              <TableCell key={actor}>
                <RuleBadge rule={matrix[actor][risk]} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The deploy-time floor as a list of rules. */
export function FloorTable({ floor }: { floor: GateFloor }) {
  const rules = Object.entries(floor).flatMap(([actor, byRisk]) =>
    Object.entries(byRisk ?? {}).map(([risk, rule]) => ({
      actor: actor as Actor | "*",
      risk,
      rule: rule as GateRule,
    })),
  );
  if (!rules.length) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="policy-floor">
        No floor is set for this deployment.
      </p>
    );
  }
  return (
    <Table aria-label="Deploy-time floor" data-testid="policy-floor">
      <TableHeader>
        <TableRow>
          <TableHead>Who</TableHead>
          <TableHead>Risk</TableHead>
          <TableHead>At least</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map(({ actor, risk, rule }) => (
          <TableRow key={`${actor}:${risk}`}>
            <TableCell>{ACTOR_LABELS[actor] ?? actor}</TableCell>
            <TableCell>{risk === "*" ? "any" : risk}</TableCell>
            <TableCell>
              <RuleBadge rule={rule} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
