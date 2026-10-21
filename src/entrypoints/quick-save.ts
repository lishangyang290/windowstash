import { browser } from 'wxt/browser';
import { showQuickSaveDialog } from '@/features/workspaces/quickSaveDialog';

export default defineUnlistedScript(() => showQuickSaveDialog(message => browser.runtime.sendMessage(message)));
