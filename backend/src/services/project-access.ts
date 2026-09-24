import { getProject, type ProjectRecord } from './project-service.js';
import { readShares, roleFromGrants, type ProjectRole } from './project-shares.js';

/**
 * Who may do what to a project, answered once per request.
 *
 * Every project-scoped route asks this before it reads or writes, and then
 * works on `ownerId`'s records — the project, its document, its conversation
 * and its versions all stay in the owner's partition whoever is acting. A
 * route that reached for `auth.userId` instead would read an empty partition
 * for a collaborator, or worse, write a second copy of the project into it.
 */
export interface ProjectAccess {
  ownerId: string;
  role: ProjectRole;
  /** The project row, without its document. */
  project: ProjectRecord;
}

export async function projectAccess(
  caller: { userId: string; group: string | null },
  projectId: string
): Promise<ProjectAccess | null> {
  if (!projectId) return null;
  const own = await getProject(caller.userId, projectId, { document: false });
  if (own) return { ownerId: caller.userId, role: 'owner', project: own };

  const { ownerId, grants } = await readShares(projectId);
  if (!ownerId || ownerId === caller.userId) return null;
  const role = roleFromGrants(grants, caller.userId, caller.group);
  if (!role) return null;
  const project = await getProject(ownerId, projectId, { document: false });
  return project ? { ownerId, role, project } : null;
}
