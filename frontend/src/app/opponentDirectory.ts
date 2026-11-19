import type { Encounter, OpponentStats } from "./api";
import { statsGroup, type MatchResult, type OpponentReport } from "./opponentAnalysis";

export type Contact = { person: Encounter; match: MatchResult; stats: OpponentStats | null };
export type OutcomeFilter = "all" | "out_kill" | "in_kill" | "no_kill";
export type DirectorySort = "kd" | "matches" | "recent";

export function reportContacts(report: OpponentReport): Contact[] {
  // Matches arrive in descending start-time order, including partial reports.
  return report.matches.flatMap((match) => {
    const group = statsGroup(match);
    return (match.encounters?.opponents ?? []).map((person) => ({
      person,
      match,
      stats: report.stats[`${group}/${person.player_id}`] ?? null,
    }));
  });
}

export function filterContacts(contacts: Contact[], query: string, outcome: OutcomeFilter) {
  const search = query.trim().toLocaleLowerCase();
  const matchingIds = new Set<string>();
  if (search) {
    for (const { person } of contacts) {
      if ([person.name, person.player_id].some((value) => value.toLocaleLowerCase().includes(search))) {
        matchingIds.add(person.player_id);
      }
    }
  }
  return contacts.filter(({ person }) => {
    if (search && !matchingIds.has(person.player_id)) return false;
    if (outcome === "all") return true;
    if (outcome === "no_kill")
      return !person.actions.includes("out_kill") && !person.actions.includes("in_kill");
    return person.actions.includes(outcome);
  });
}

export function opponentGroups(contacts: Contact[], sort: DirectorySort) {
  const groups = new Map<string, Contact[]>();
  for (const contact of contacts) {
    const id = contact.person.player_id;
    const group = groups.get(id);
    if (group) group.push(contact);
    else groups.set(id, [contact]);
  }
  const rows = [...groups.values()];
  // Preserve most recent encounter order on ties. Unknown KD follows all known values, including 0.
  if (sort === "kd") rows.sort((a, b) => (b[0].stats?.kd ?? -1) - (a[0].stats?.kd ?? -1));
  if (sort === "matches") rows.sort((a, b) => b.length - a.length);
  return rows;
}
