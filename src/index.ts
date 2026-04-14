#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";

const GenerateBriefSchema = z.object({
  project_path: z.string().describe("The absolute path to the project to summarize."),
  output_file: z.string().default("PROJECT_BRIEF.md").describe("The filename for the summary.")
});

class ProjectBrieferServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: "project-briefer",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    this.server.onerror = (error) => console.error("[MCP Error]", error);
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "generate_brief",
          description: "Scans a project directory and generates a markdown summary of its structure, files, and key logic to help other AI agents understand where to continue.",
          inputSchema: {
            type: "object",
            properties: {
              project_path: {
                type: "string",
                description: "The absolute path of the project."
              },
              output_file: {
                type: "string",
                description: "Name of the summary file (default: PROJECT_BRIEF.md)."
              }
            },
            required: ["project_path"]
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== "generate_brief") {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }

      try {
        const { project_path, output_file } = GenerateBriefSchema.parse(request.params.arguments);
        const briefContent = await this.summarizeProject(project_path);
        const outputPath = path.join(project_path, output_file);
        await fs.writeFile(outputPath, briefContent);
        
        return {
          content: [
            {
              type: "text",
              text: `Project brief generated successfully at: ${outputPath}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error generating brief: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async summarizeProject(dir: string): Promise<string> {
    let summary = `# Project Brief: ${path.basename(dir)}\n\n`;
    summary += `**Generated on:** ${new Date().toLocaleString()}\n\n`;
    
    summary += `## 📂 Directory Structure\n\n\`\`\`\n`;
    const structure = await this.getStructure(dir, "", 0);
    summary += structure + `\`\`\`\n\n`;

    summary += `## 📝 File Summaries\n\n`;
    const files = await this.getAllFiles(dir);
    for (const file of files) {
      const relativePath = path.relative(dir, file);
      if (this.shouldSkip(relativePath) || !this.isCodeFile(file)) continue;
      
      const content = await fs.readFile(file, "utf8");
      const analysis = this.analyzeFile(relativePath, content);
      
      summary += `### 📄 ${relativePath}\n`;
      summary += `**Role:** ${analysis.role}\n`;
      if (analysis.exports.length > 0) {
        summary += `**Key Exports/Methods:** \`${analysis.exports.join("`, `")}\`\n`;
      }
      summary += `\n`;
    }

    return summary;
  }

  private isCodeFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    const codeExts = [".ts", ".js", ".java", ".svelte", ".py", ".c", ".cpp", ".h", ".rs", ".go", ".gradle"];
    const configFiles = ["package.json", "tsconfig.json", "svelte.config.js", "vite.config.ts", "vite.config.js", "build.gradle", "settings.gradle"];
    
    return codeExts.includes(ext) || configFiles.includes(path.basename(filePath));
  }

  private async getStructure(dir: string, prefix: string, depth: number): Promise<string> {
    if (depth > 5) return ""; // Limit depth
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let result = "";
    
    for (const entry of entries) {
      if (this.shouldSkip(entry.name)) continue;
      
      const isLast = entries.indexOf(entry) === entries.length - 1;
      result += `${prefix}${isLast ? "└── " : "├── "}${entry.name}${entry.isDirectory() ? "/" : ""}\n`;
      
      if (entry.isDirectory()) {
        result += await this.getStructure(path.join(dir, entry.name), prefix + (isLast ? "    " : "│   "), depth + 1);
      }
    }
    return result;
  }

  private async getAllFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map((entry) => {
      const res = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (this.shouldSkip(entry.name)) return [];
        return this.getAllFiles(res);
      }
      return res;
    }));
    return files.flat();
  }

  private shouldSkip(name: string): boolean {
    const skip = ["node_modules", ".git", "dist", ".DS_Store", "package-lock.json", "PROJECT_BRIEF.md", "static/", "assets/", "data/"];
    return skip.some(s => name.includes(s));
  }

  private analyzeFile(name: string, content: string) {
    const ext = path.extname(name);
    let role = "General source file";
    let exports: string[] = [];

    if (name.includes("package.json")) role = "Project configuration and dependencies";
    else if (name.includes("tsconfig.json")) role = "TypeScript configuration";
    else if (name.includes("build.gradle") || name.includes("settings.gradle")) role = "Gradle build configuration";
    else if (ext === ".ts" || ext === ".js" || ext === ".java") {
      role = ext === ".java" ? "Java implementation" : "Logic implementation";
      // Basic regex for exports/methods/classes
      const exportMatches = content.matchAll(/export (?:const|function|class|type|interface) (\w+)/g);
      const tsExports = Array.from(exportMatches).map(m => m[1]);
      
      const javaClassMatches = content.matchAll(/(?:public|private|protected)?\s*(?:static|final)?\s*(?:class|interface|enum)\s+(\w+)/g);
      const javaClasses = Array.from(javaClassMatches).map(m => m[1]);

      const methodMatches = content.matchAll(/(?:public|private|protected|static|final|synchronized|async)?\s+[\w<>[\]]+\s+(\w+)\s*\(.*\)\s*(?:throws\s+[\w, ]+)?\s*{/g);
      const methods = Array.from(methodMatches).map(m => m[1]).filter(m => !["if", "for", "while", "switch", "catch", "return", "new", "this"].includes(m));
      
      exports = [...new Set([...tsExports, ...javaClasses, ...methods])];
    }
    else if (ext === ".svelte") role = "UI component";
    else if (ext === ".css") role = "Styles";
    else if (ext === ".md") role = "Documentation";
    else if (ext === ".json") role = "Data/Configuration";

    return { role, exports: exports.slice(0, 10) }; // Limit exports
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Project-Briefer MCP server running on stdio");
  }
}

const server = new ProjectBrieferServer();
server.run().catch(console.error);
