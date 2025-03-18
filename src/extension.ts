import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import ignore from "ignore";
import hljs from "highlight.js";
import { isBinaryFileSync } from "isbinaryfile";
import { glob } from "glob";
import * as mammoth from "mammoth";

let generatedMarkdown: string = "";

interface FileInfo {
  relativePath: string;
  content: string;
}

// Path normalization function
const normalizePath = (filePath: string): string => path.posix.normalize(filePath.split(path.sep).join(path.posix.sep));

// Function to create a unique code fence
const createUniqueFence = (content: string): string => {
  const backtickGroups = content.match(/`+/g) || [];
  const maxBackticks = Math.max(...backtickGroups.map((group) => group.length), 2);
  return "`".repeat(maxBackticks + 1);
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const markdownPreviewProvider = new MarkdownPreviewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MarkdownPreviewProvider.viewType, markdownPreviewProvider),
    vscode.commands.registerCommand("recursive-markdown-generator.generate", () => generateAndUpdateMarkdown(markdownPreviewProvider)),
    vscode.commands.registerCommand("recursive-markdown-generator.download", () => downloadMarkdown())
  );
}

async function generateAndUpdateMarkdown(markdownPreviewProvider: MarkdownPreviewProvider): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("No workspace folder open");
    return;
  }

  try {
    markdownPreviewProvider.updateContent("Generating markdown...");
    const config = vscode.workspace.getConfiguration("recursiveMarkdownGenerator");
    const ig = await createIgnoreFilter(config, workspaceFolder.uri.fsPath);
    const fileInfos = await collectFileInfos(workspaceFolder.uri.fsPath, ig);
    generatedMarkdown = generateMarkdownFromFileInfos(fileInfos);
    const htmlContent = convertFileInfosToHtml(fileInfos);
    markdownPreviewProvider.updateContent(htmlContent);
    vscode.window.showInformationMessage("Markdown generated successfully");
  } catch (error) {
    vscode.window.showErrorMessage(`Error generating markdown: ${error instanceof Error ? error.message : String(error)}`);
    markdownPreviewProvider.updateContent("Error generating markdown. Please try again.");
  }
}

async function createIgnoreFilter(config: vscode.WorkspaceConfiguration, workspacePath: string): Promise<ReturnType<typeof ignore>> {
  const ignorePatterns: string[] = config.get("ignorePatterns") || [];
  const ignoreFiles: string[] = config.get("ignoreFiles") || [".gitignore"];
  const ig = ignore().add(ignorePatterns);

  for (const ignoreFile of ignoreFiles) {
    const ignoreFilePath = path.join(workspacePath, ignoreFile);
    try {
      const ignoreFileContent = await fs.readFile(ignoreFilePath, "utf-8");
      ig.add(ignoreFileContent);
    } catch (error) {
      console.warn(`Failed to read ignore file: ${ignoreFilePath}`);
    }
  }

  return ig;
}

async function collectFileInfos(directory: string, ig: ReturnType<typeof ignore>): Promise<FileInfo[]> {
  // Use the new glob API
  const files = await glob("**/*", {
    cwd: directory,
    dot: true,
    nodir: true,
    absolute: true,
  });

  const fileInfos: FileInfo[] = [];

  await Promise.all(
    files.map(async (filePath) => {
      const relativePath = path.relative(directory, filePath);
      const normalizedPath = normalizePath(relativePath);

      // Ignore filtered files
      if (ig.ignores(normalizedPath)) {
        return;
      }

      const fileExtension = path.extname(filePath).toLowerCase();

      // Special handling for docx files
      if (fileExtension === ".docx") {
        try {
          const content = await extractDocxText(filePath);
          fileInfos.push({ relativePath: normalizedPath, content });
        } catch (error) {
          console.error(`Error reading DOCX file ${filePath}:`, error);
        }
        return;
      }

      // Skip other binary files
      if (isBinaryFileSync(filePath)) {
        return;
      }

      // Process normal text files
      try {
        const content = await readFileContent(filePath);
        fileInfos.push({ relativePath: normalizedPath, content });
      } catch (error) {
        console.error(`Error reading file ${filePath}:`, error);
      }
    })
  );

  return fileInfos;
}

// Function to extract text from a DOCX file
async function extractDocxText(filePath: string): Promise<string> {
  try {
    const buffer = await fs.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value || `[No text content found in ${path.basename(filePath)}]`;
  } catch (error) {
    throw new Error(`Unable to extract text from DOCX file: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function generateMarkdownFromFileInfos(fileInfos: FileInfo[]): string {
  return fileInfos
    .map(({ relativePath, content }) => {
      const fence = createUniqueFence(content);
      const fileExtension = path.extname(relativePath).slice(1);
      return `### ${relativePath}\n${fence}${fileExtension}\n${content}\n${fence}\n`;
    })
    .join("\n");
}

async function readFileContent(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    throw new Error(`Unable to read file: ${filePath}`);
  }
}

function convertFileInfosToHtml(fileInfos: FileInfo[]): string {
  return fileInfos
    .map(({ relativePath, content }) => {
      const fileExtension = path.extname(relativePath).toLowerCase();
      let highlightedCode: string;
      let language: string;

      // For DOCX files, don't apply syntax highlighting
      if (fileExtension === ".docx") {
        highlightedCode = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        language = "plaintext";
      } else {
        // For other files, use syntax highlighting
        const highlighted = hljs.highlightAuto(content);
        highlightedCode = highlighted.value;
        language = highlighted.language || "plaintext";
      }

      return `
      <h3>${relativePath}</h3>
      <pre class="theme-atom-one-dark"><code class="hljs ${language}">${highlightedCode}</code></pre>
    `;
    })
    .join("");
}

async function downloadMarkdown(): Promise<void> {
  if (!generatedMarkdown) {
    vscode.window.showErrorMessage("No markdown generated yet. Please generate markdown first.");
    return;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("No workspace folder open");
    return;
  }

  const defaultPath = path.join(workspaceFolder.uri.fsPath, "generated_markdown.md");
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(defaultPath),
    filters: { Markdown: ["md"] },
  });

  if (uri) {
    await fs.writeFile(uri.fsPath, generatedMarkdown);
    vscode.window.showInformationMessage(`Markdown saved to ${uri.fsPath}`);
  }
}

class MarkdownPreviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "recursiveMarkdownView";
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.onDidChangeVisibility(async () => {
      if (webviewView.visible) {
        await generateAndUpdateMarkdown(this);
      }
    });

    generateAndUpdateMarkdown(this);
  }

  public updateContent(content: string): void {
    if (this._view) {
      this._view.webview.postMessage({ type: "update", content });
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "main.js"));

    return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Recursive Markdown Preview</title>
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/atom-one-dark.min.css"/>
                <style>
                    body { font-family: Arial, sans-serif; padding: 10px; }
                    pre { padding: 10px; border-radius: 5px; }
                    .hljs { color: #abb2bf; background: #282c34; }
                </style>
            </head>
            <body>
                <div id="content">Loading...</div>
                <script src="${scriptUri}"></script>
            </body>
            </html>`;
  }
}

export function deactivate(): void {}
