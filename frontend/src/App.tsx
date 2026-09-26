/**
 * The app shell: the sign-in form until there is a session, then the project list
 * or the open project.
 */
import { useState } from 'react';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ProjectList } from './components/project-list/ProjectList';
import { useProjects, type Project } from './hooks/useProjects';
import { navigate } from './utils/motion/viewTransition';
import { LoginForm } from './auth/LoginForm';
import { Workspace } from './components/workspace/Workspace';

function AppContent() {
  const { isAuthenticated, loading } = useAuth();
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const { updateProject, fetchProjectPreview } = useProjects();

  if (loading) {
    return (
      <div className="app-loading" role="status" aria-label="読み込み中">
        <div className="app-loading__spinner" aria-hidden="true" />
        <p>読み込み中...</p>
      </div>
    );
  }

  if (!isAuthenticated) return <LoginForm />;

  /*
   * Into a project and back out, as a push and a pop — see utils/motion/viewTransition.ts.
   */
  const open = (project: Project) => navigate(() => setCurrentProject(project), 'forward');

  if (!currentProject) {
    return <ProjectList onOpenProject={open} onNewProject={open} />;
  }

  return (
    <Workspace
      key={currentProject.projectId}
      project={currentProject}
      onBackToProjects={() => navigate(() => setCurrentProject(null), 'back')}
      onUpdateProject={updateProject}
      fetchProjectPreview={fetchProjectPreview}
    />
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ErrorBoundary>
  );
}
