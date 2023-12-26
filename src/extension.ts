import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	// 注册命令
	let disposable = vscode.commands.registerCommand('custom-postfix-template.refresh-configs', tryCommand(refreshConfigs));
	context.subscriptions.push(disposable);
	disposable = vscode.commands.registerCommand('custom-postfix-template.expand', tryCommand(expandTemplate));
	context.subscriptions.push(disposable);

	// 初始计划配置
	refreshConfigs();
	// 配置变化时重新加载配置
	vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('custom-postfix-template')) {
			refreshConfigs();
		}
	});
}
function tryCommand(callback: (...args: any[]) => any): (...args: any[]) => any {
	return function () {
		try {
			callback();
		} catch (error) {
			console.log(error);
			vscode.window.showErrorMessage('fail to execute command, you can check console to see more details');
		}
	}
}

const DEFAULT_WORD_REGEX = /\w+/
let configuration: vscode.WorkspaceConfiguration;
let languagePostfixTemplatesMap: Map<string, LanguagePostfixTemplate>;
interface LanguagePostfixTemplate {
	triggerWord: string;
	description: string;
	exprRegExp: RegExp;
	contents: string[];
}

function refreshConfigs() {
	configuration = vscode.workspace.getConfiguration('custom-postfix-template');
	if (!configuration) {
		return;
	}
	let templatesConfigRaw = configuration.get('templates')
	if (!templatesConfigRaw) {
		return;
	}
	let templatesConfig = templatesConfigRaw as { [key: string]: any }
	const languageIds = Object.keys(templatesConfigRaw);

	let newMap = new Map();
	languageIds.forEach((languageId) => {
		let eachLangTemplate = templatesConfig[languageId] as { templates: LanguagePostfixTemplate[]; };
		const templateList = eachLangTemplate.templates;
		templateList.forEach((template) => {
			if (template.exprRegExp) {
				template.exprRegExp = new RegExp(template.exprRegExp);
			} else {
				template.exprRegExp = DEFAULT_WORD_REGEX
			}
			newMap.set(getKey(languageId, template.triggerWord), template);
		})
	});
	languagePostfixTemplatesMap = newMap;
	console.log("languagePostfixTemplatesMap", JSON.stringify(Array.from(languagePostfixTemplatesMap.entries())));
}

function getKey(language: string, triggerWord: string): string {
	return language + ':' + triggerWord;
}

function expandTemplate() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	// 获取触发词范围
	const cursorPosition = editor.selection.end;
	const triggerWordRange = editor.document.getWordRangeAtPosition(cursorPosition, DEFAULT_WORD_REGEX);
	console.log("triggerWordRange", triggerWordRange);
	if (!triggerWordRange) {
		return;
	}
	// 检查触发词前面是否 . 字符
	let dotPosition = triggerWordRange.start.translate(0, -1);
	console.log("dotPosition", dotPosition);
	let dotStr = editor.document.getText(new vscode.Range(dotPosition, dotPosition.translate(0, 1)));
	if (!dotStr || dotStr !== '.') {
		return
	}

	// 检查模板配置是否包含此触发词
	const triggerWord = editor.document.getText(triggerWordRange);
	const key = getKey(editor.document.languageId, triggerWord);
	let template = languagePostfixTemplatesMap.get(key)
	if (!template) {
		return;
	}

	// 获取模板应用的表达式
	const exprRange = editor.document.getWordRangeAtPosition(dotPosition.translate(0, -1), template.exprRegExp);
	console.log("exprRange", exprRange);
	if (!exprRange) {
		return;
	}
	let exprWord = editor.document.getText(exprRange);
	console.log("triggerWord", triggerWord, "exprWord", exprWord);
	if (!triggerWord || !exprWord) {
		return;
	}
	if (exprWord.endsWith('.' + triggerWord)) {
		exprWord = exprWord.substring(0, exprWord.length - triggerWord.length - 1)
	}
	console.log("triggerWord", triggerWord, "exprWord", exprWord);

	// todo 完善插入snippet的逻辑
	const snippet = expandMyTemplate(cursorPosition, triggerWordRange, triggerWord, template);
	if (snippet) {
		let replaceRange = new vscode.Range(exprRange.start, triggerWordRange.end);
		editor.insertSnippet(new vscode.SnippetString(snippet), replaceRange);
	}
}

function expandMyTemplate(cursorPosition: vscode.Position, wordRange: vscode.Range, word: string, template: LanguagePostfixTemplate): string {
	return template.contents.join('\n');
}

export function deactivate() { }
