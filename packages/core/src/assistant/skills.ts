// Skills a routine can run in its short model turn (ADR 0343): named instructions, so "prep notes
// before a meeting" is written once. First-party ones are here; W7's plugin install registers
// theirs with `routineSkills.register`.
export interface RoutineSkill {
  name: string;
  description: string;
  instructions: string;
}

const FIRST_PARTY: readonly RoutineSkill[] = [
  {
    name: "meeting.prep",
    description: "Prep notes for a meeting: who is coming, what was said last, what is open",
    instructions:
      "Write short prep notes for this meeting: who is coming and their role, what was last " +
      "discussed with them, and anything open (tasks, deals). Read their records and timeline " +
      "first. A few short lines. If you find nothing useful, say so in one line.",
  },
  {
    name: "pipeline.week",
    description: "This week in your pipeline: what moved, what is due, what went quiet",
    instructions:
      "Write a short summary of the person's pipeline this week: deals that moved, what is due " +
      "to close and what has gone quiet. Name the deals. A few short lines.",
  },
];

function createSkillRegistry(initial: readonly RoutineSkill[]) {
  const skills = new Map(initial.map((s) => [s.name, s]));
  return {
    get: (name: string) => skills.get(name),
    list: () => [...skills.values()],
    register: (skill: RoutineSkill) => void skills.set(skill.name, skill),
  };
}

export const routineSkills = createSkillRegistry(FIRST_PARTY);
