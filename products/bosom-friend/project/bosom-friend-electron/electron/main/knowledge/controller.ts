/**
 * KnowledgeController - 知识库 IPC
 */
import { Controller, Icp, Inject } from '../core/decorators';
import { app } from 'electron';
import path from 'path';
import { KnowledgeService } from './service';
import { removeVaultNoteFromKernel, syncVaultNoteToKernel } from './kernel-sync';

@Controller()
export class KnowledgeController {
  @Inject(KnowledgeService)
  private readonly knowledgeService!: KnowledgeService;

  @Icp('KB_GET_VAULT')
  async getVault() {
    const vaultPath = this.knowledgeService.getVaultPath();
    const builtInPath = path.join(app.getPath('userData'), '知音知识库');
    return {
      path: vaultPath,
      builtIn: vaultPath === builtInPath,
    };
  }

  @Icp('KB_CHOOSE_VAULT')
  async chooseVault() {
    return this.knowledgeService.chooseVault();
  }

  @Icp('KB_LIST_TREE')
  async listTree() {
    return this.knowledgeService.listTree();
  }

  @Icp('KB_READ')
  async read(_event: Electron.IpcMainInvokeEvent, relPath: string) {
    return this.knowledgeService.readNote(relPath);
  }

  @Icp('KB_WRITE')
  async write(_event: Electron.IpcMainInvokeEvent, relPath: string, content: string) {
    const ok = await this.knowledgeService.writeNote(relPath, content);
    if (ok)
      void syncVaultNoteToKernel(this.knowledgeService.getVaultPath(), relPath);
    return ok;
  }

  @Icp('KB_CREATE')
  async create(_event: Electron.IpcMainInvokeEvent, relPath: string, content?: string) {
    const normalized = await this.knowledgeService.createNote(relPath, content);
    void syncVaultNoteToKernel(this.knowledgeService.getVaultPath(), normalized);
    return normalized;
  }

  @Icp('KB_DELETE')
  async remove(_event: Electron.IpcMainInvokeEvent, relPath: string) {
    const ok = await this.knowledgeService.deleteNote(relPath);
    if (ok)
      removeVaultNoteFromKernel(relPath);
    return ok;
  }

  @Icp('KB_RENAME')
  async rename(_event: Electron.IpcMainInvokeEvent, oldPath: string, newPath: string) {
    const renamed = await this.knowledgeService.renameNote(oldPath, newPath);
    removeVaultNoteFromKernel(oldPath);
    void syncVaultNoteToKernel(this.knowledgeService.getVaultPath(), renamed);
    return renamed;
  }

  @Icp('KB_SEARCH')
  async search(_event: Electron.IpcMainInvokeEvent, query: string) {
    return this.knowledgeService.searchNotes(query);
  }

  @Icp('KB_BACKLINKS')
  async backlinks(_event: Electron.IpcMainInvokeEvent, relPath: string) {
    return this.knowledgeService.getBacklinks(relPath);
  }
}
