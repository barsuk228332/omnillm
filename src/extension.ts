import * as vscode from 'vscode';
import { ChatViewProvider } from './provider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('omnillm.open', () => provider.open());
  register('omnillm.newChat', () => provider.newChat());
  register('omnillm.addSelection', () => provider.addSelection());
  register('omnillm.addFile', () => provider.addFile());
  register('omnillm.refreshModels', () => provider.refreshModels(true));
  register('omnillm.setApiKey', () => provider.promptForApiKey());
  register('omnillm.keyStatus', () => provider.keyStatus());
  register('omnillm.clearApiKey', () => provider.clearApiKey());

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('omnillm.baseUrl') ||
        event.affectsConfiguration('omnillm.modelsQuery')
      ) {
        void provider.configurationChanged();
      }
    }),
  );

  void provider.warmUp();
}

export function deactivate(): void {
  // ничего не нужно: подписки освобождаются VS Code
}
