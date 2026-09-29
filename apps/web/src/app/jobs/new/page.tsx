import { requirePageUser } from '../../../lib/auth';
import { NewJobForm } from '../../../components/new-job-form';
import { getConfig } from '../../../lib/runtime';

export const dynamic = 'force-dynamic';

export default async function NewMigrationPage() {
  await requirePageUser();
  const config = getConfig();
  return (
    <div className="page-content new-migration-page">
      <p className="breadcrumb">
        <a href="/">移行一覧</a> / 新しい移行
      </p>
      <h1 className="page-title">新しい移行</h1>
      <NewJobForm
        classicFolderPicker={process.env.SHUTTLE_CLASSIC_FOLDER_PICKER === 'true'}
        authenticated={config.env.BOX_AUTH_MODE === 'oauth'}
        aiEnabled={config.ai.enabled}
        boxMode={config.box.mode}
        folderPickerAvailable={process.platform === 'darwin'}
      />
    </div>
  );
}
