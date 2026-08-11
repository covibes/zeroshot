import fs = require('fs');
import path = require('path');

interface ManualInput {
  number: null;
  title: string;
  body: string;
  labels: unknown[];
  comments: unknown[];
  url: null;
  context: string;
}

/**
 * Input Helpers - Create input data from text or files
 *
 * Provides fallback input methods for non-issue-based input:
 * - Plain text input
 * - File input (markdown)
 */
class InputHelpers {
  static createTextInput(text: string): ManualInput {
    return {
      number: null,
      title: 'Manual Input',
      body: text,
      labels: [],
      comments: [],
      url: null,
      context: `# Manual Input\n\n${text}\n`,
    };
  }

  static createFileInput(filePath: string): ManualInput {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileContent = fs.readFileSync(resolvedPath, 'utf8');
    const headerMatch = /^#\s+(.+)$/m.exec(fileContent);
    const extractedTitle = headerMatch?.[1]?.trim() ?? null;
    const fallbackTitle = path.basename(filePath, path.extname(filePath));
    const title = extractedTitle || fallbackTitle;

    return {
      number: null,
      title,
      body: fileContent,
      labels: [],
      comments: [],
      url: null,
      context: `# ${title}\n\n${fileContent}\n`,
    };
  }
}

export = InputHelpers;
