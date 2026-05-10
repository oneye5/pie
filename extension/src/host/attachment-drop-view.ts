import * as vscode from 'vscode';

import { parseFileUriList } from '../shared/file-uri-list';

export const ATTACHMENTS_VIEW_ID = 'pi-assistant.attachmentsView';

interface AttachmentDropNode {
  id: string;
  kind: 'drop-target';
}

export class AttachmentDropView implements vscode.TreeDataProvider<AttachmentDropNode>, vscode.TreeDragAndDropController<AttachmentDropNode>, vscode.Disposable {
  readonly dropMimeTypes = ['files', 'text/uri-list'];
  readonly dragMimeTypes: string[] = [];

  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly treeView: vscode.TreeView<AttachmentDropNode>;
  private readonly rootNode: AttachmentDropNode = { id: 'drop-target', kind: 'drop-target' };

  constructor(
    context: vscode.ExtensionContext,
    private readonly onAttachUris: (uris: vscode.Uri[]) => Promise<void>,
  ) {
    this.treeView = vscode.window.createTreeView(ATTACHMENTS_VIEW_ID, {
      treeDataProvider: this,
      showCollapseAll: false,
      canSelectMany: false,
      dragAndDropController: this,
    });
    this.treeView.message = 'Drop files or folders here to attach them to PI Assistant.';
    context.subscriptions.push(this.treeView, this);
  }

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }

  getChildren(element?: AttachmentDropNode): AttachmentDropNode[] {
    if (element) {
      return [];
    }

    return [this.rootNode];
  }

  getTreeItem(element: AttachmentDropNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      'Drop Files Here',
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = 'Temporary native drop target';
    item.tooltip = 'Drag files or folders from VS Code Explorer or your operating system here to attach them to the PI Assistant composer.';
    item.iconPath = new vscode.ThemeIcon('attach');
    item.command = {
      command: 'pi-assistant.attachFiles',
      title: 'Attach Files',
    };
    return item;
  }

  async handleDrop(
    _target: AttachmentDropNode | undefined,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const droppedUris = await extractFileDropUris(dataTransfer, token);
    if (droppedUris.length === 0) {
      void vscode.window.showWarningMessage('PI Assistant: This drop did not include any attachable file paths.');
      return;
    }

    await this.onAttachUris(droppedUris);
  }
}

async function extractFileDropUris(
  dataTransfer: vscode.DataTransfer,
  token?: vscode.CancellationToken,
): Promise<vscode.Uri[]> {
  const uris: vscode.Uri[] = [];
  const seen = new Set<string>();

  function addUri(uri: vscode.Uri | undefined): void {
    if (!uri || uri.scheme !== 'file' || seen.has(uri.fsPath)) {
      return;
    }
    seen.add(uri.fsPath);
    uris.push(uri);
  }

  const uriListItem = dataTransfer.get('text/uri-list');
  if (uriListItem) {
    const rawUriList = await uriListItem.asString();
    if (token?.isCancellationRequested) {
      return [];
    }

    for (const filePath of parseFileUriList(rawUriList)) {
      addUri(vscode.Uri.file(filePath));
    }
  }

  for (const [, item] of dataTransfer) {
    const file = item.asFile();
    addUri(file?.uri);
  }

  return uris;
}
