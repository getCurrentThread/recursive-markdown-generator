import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import ignore from "ignore";
import hljs from "highlight.js";
import { isBinaryFile } from "isbinaryfile";
import { glob } from "glob";
import * as mammoth from "mammoth";


interface FileInfo {
  relativePath: string;
  content: string;
}

// Path normalization function
const normalizePath = (filePath: string): string => path.posix.normalize(filePath.split(path.sep).join(path.posix.sep));

// HTML escape map for single-pass escaping
const htmlEscapeMap: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
};

// Single-pass HTML escape function
const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => htmlEscapeMap[char]);

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
    vscode.commands.registerCommand("recursive-markdown-generator.download", () => downloadMarkdown(markdownPreviewProvider))
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
    const maxFileSize :number = config.get("maxFileSize") || 512000; // 500KB in bytes
    const fileInfos = await collectFileInfos(workspaceFolder.uri.fsPath, ig, maxFileSize);
    markdownPreviewProvider.generatedMarkdown = generateMarkdownFromFileInfos(fileInfos);
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

async function collectFileInfos(directory: string, ig: ReturnType<typeof ignore>, maxFileSize: number): Promise<FileInfo[]> {

  // Use the new glob API
  const files = await glob("**/*", {
    cwd: directory,
    dot: true,
    nodir: true,
    absolute: true,
  });

  const results = await Promise.all(
    files.map(async (filePath): Promise<FileInfo | null> => {
      const relativePath = path.relative(directory, filePath);
      const normalizedPath = normalizePath(relativePath);

      // Ignore filtered files
      if (ig.ignores(normalizedPath)) {
        return null;
      }

      // Check file size and skip if too large
      try {
        const stats = await fs.stat(filePath);
        if (stats.size > maxFileSize) {
          console.log(`Skipping large file (${stats.size} bytes > ${maxFileSize} bytes): ${normalizedPath}`);
          return null;
        }
      } catch (error) {
        console.error(`Error getting file stats ${filePath}:`, error);
        return null;
      }

      const fileExtension = path.extname(filePath).toLowerCase();

      // Special handling for docx files
      if (fileExtension === ".docx") {
        try {
          const content = await extractDocxText(filePath);
          return { relativePath: normalizedPath, content };
        } catch (error) {
          console.error(`Error reading DOCX file ${filePath}:`, error);
          return null;
        }
      }

      // Skip other binary files
      if (await isBinaryFile(filePath)) {
        return null;
      }

      // Process normal text files
      try {
        const content = await readFileContent(filePath);
        return { relativePath: normalizedPath, content };
      } catch (error) {
        console.error(`Error reading file ${filePath}:`, error);
        return null;
      }
    })
  );

  return results.filter((info): info is FileInfo => info !== null);
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
        highlightedCode = escapeHtml(content);
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

async function downloadMarkdown(markdownPreviewProvider: MarkdownPreviewProvider): Promise<void> {
  if (!markdownPreviewProvider.generatedMarkdown) {
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
    await fs.writeFile(uri.fsPath, markdownPreviewProvider.generatedMarkdown);
    vscode.window.showInformationMessage(`Markdown saved to ${uri.fsPath}`);
  }
}

class MarkdownPreviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "recursiveMarkdownView";
  private _view?: vscode.WebviewView;
  private _generatedMarkdown: string = "";
  private _isInitialized: boolean = false;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public get generatedMarkdown(): string {
    return this._generatedMarkdown;
  }

  public set generatedMarkdown(value: string) {
    this._generatedMarkdown = value;
  }

  public resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.onDidChangeVisibility(async () => {
      if (webviewView.visible && !this._isInitialized) {
        this._isInitialized = true;
        await generateAndUpdateMarkdown(this);
      }
    });

    if (!this._isInitialized) {
      this._isInitialized = true;
      generateAndUpdateMarkdown(this);
    }
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
