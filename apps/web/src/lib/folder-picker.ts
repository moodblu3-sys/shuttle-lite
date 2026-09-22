import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { posix } from 'node:path';

export type FolderSelection =
  { cancelled: true } | { cancelled: false; path: string; name: string };

export class FolderPickerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// The script is constant: neither request data nor the chosen path is executable input.
// Apple: Mac Automation Scripting Guide / Prompting for Files or Folders.
const CHOOSE_FOLDER = `
with timeout of 180 seconds
  try
    set selectedFolder to choose folder with prompt "Shuttle Lite：移行元フォルダーを選択してください" multiple selections allowed false
    return "selected:" & (POSIX path of selectedFolder)
  on error number -128
    return "cancelled"
  end try
end timeout
`;

let dialogOpen = false;

export async function chooseSourceFolder(signal: AbortSignal): Promise<FolderSelection> {
  if (platform() !== 'darwin') {
    throw new FolderPickerError(
      'フォルダー選択はMacで利用できます。Mac上でアプリを起動してください。',
      501,
    );
  }
  if (dialogOpen) {
    throw new FolderPickerError(
      'フォルダー選択画面はすでに開いています。そちらで選択してください。',
      409,
    );
  }
  if (signal.aborted) return { cancelled: true };
  dialogOpen = true;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        '/usr/bin/osascript',
        ['-e', CHOOSE_FOLDER],
        { encoding: 'utf8', shell: false, timeout: 180_000, maxBuffer: 64 * 1024, signal },
        (error, output) => (error ? reject(error) : resolve(output)),
      );
    });
    // Remove only osascript's final line ending; spaces/newlines may belong to the folder name.
    const output = stdout.replace(/\r?\n$/, '');
    if (output === 'cancelled') return { cancelled: true };
    if (!output.startsWith('selected:')) throw new Error('Invalid folder selection');
    const path = output.slice('selected:'.length);
    if (!posix.isAbsolute(path) || path.includes('\0')) throw new Error('Invalid folder path');
    return { cancelled: false, path, name: posix.basename(path) || path };
  } catch {
    if (signal.aborted) return { cancelled: true };
    // Native errors may include local paths or script text; only return an actionable message.
    throw new FolderPickerError(
      'フォルダー選択を完了できませんでした。Macの選択画面や権限の案内を確認し、もう一度お試しください。',
      500,
    );
  } finally {
    dialogOpen = false;
  }
}
