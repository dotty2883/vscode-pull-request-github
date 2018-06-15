/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { Repository } from '../models/repository';
import { PullRequestModel } from '../models/pullRequestModel';
import { TreeNode } from './TreeNode';
import { Resource } from '../common/resources';
import { parseDiff } from '../common/diff';
import { Comment } from '../models/comment';
import { toPRUri } from '../common/uri';
import { mapHeadLineToDiffHunkPosition, getDiffLineByPosition } from '../common/diffPositionMapping';
import { groupBy } from '../common/util';
import { PRDescriptionNode } from './prDescNode';
import { ReviewManager } from '../review/reviewManager';
import { PRFileChangeNode } from './prFileChangeNode';
import Logger from '../logger';
import { RichFileChange } from '../models/file';

export class PRNode extends TreeNode {
	private richContentChanges: RichFileChange[];
	private commentsCache: Map<String, Comment[]>;

	constructor(
		private repository: Repository,
		public element: PullRequestModel
	) {
		super();
	}

	async getChildren(): Promise<TreeNode[]> {
		try {
			const comments = await this.element.getComments();
			const data = await this.element.getFiles();
			await this.element.fetchBaseCommitSha();
			this.richContentChanges = await parseDiff(data, this.repository, this.element.base.sha);
			this.commentsCache = new Map<String, Comment[]>();
			let fileChanges = this.richContentChanges.map(change => {
				let fileInRepo = path.resolve(this.repository.path, change.fileName);
				let changedItem = new PRFileChangeNode(
					this.element,
					change.fileName,
					change.status,
					change.fileName,
					change.blobUrl,
					toPRUri(vscode.Uri.file(change.filePath), fileInRepo, change.fileName, false),
					toPRUri(vscode.Uri.file(change.originalFilePath), fileInRepo, change.fileName, true),
					this.repository.path,
					change.diffHunks
				);
				changedItem.comments = comments.filter(comment => comment.path === changedItem.fileName);
				this.commentsCache.set(change.fileName, changedItem.comments);
				return changedItem;
			});

			const _onDidChangeCommentThreads = new vscode.EventEmitter<vscode.CommentThreadChangedEvent>();
			vscode.workspace.registerDocumentCommentProvider({
				onDidChangeCommentThreads: _onDidChangeCommentThreads.event,
				provideDocumentComments: this.provideDocumentComments.bind(this),
				createNewCommentThread: this.createNewCommentThread.bind(this),
				replyToCommentThread: this.replyToCommentThread.bind(this)
			});

			return [new PRDescriptionNode('Description', {
				light: Resource.icons.light.Description,
				dark: Resource.icons.dark.Description
			}, this.element), ...fileChanges];
		} catch (e) {
			Logger.appendLine(e);
		}
	}

	getTreeItem(): vscode.TreeItem {
		let currentBranchIsForThisPR = this.element.equals(ReviewManager.instance.currentPullRequest);
		return {
			label: (currentBranchIsForThisPR ? ' * ' : '') + this.element.title,
			tooltip: (currentBranchIsForThisPR ? 'Current Branch * ' : '') + this.element.title,
			collapsibleState: 1,
			contextValue: 'pullrequest' + (currentBranchIsForThisPR ? ':active' : ':nonactive'),
			iconPath: Resource.getGravatarUri(this.element)
		};
	}

	private async createNewCommentThread(document: vscode.TextDocument, range: vscode.Range, text: string) {
		let uri = document.uri;
		let params = JSON.parse(uri.query);

		let fileChange = this.richContentChanges.find(change => change.fileName === params.fileName);

		if (!fileChange) {
			return null;
		}

		let isBase = params && params.base;
		let position = mapHeadLineToDiffHunkPosition(fileChange.diffHunks, '', range.start.line + 1, isBase);

		if (position < 0) {
			return;
		}

		// there is no thread Id, which means it's a new thread
		let ret = await this.element.createComment(text, params.fileName, position);
		let comment: vscode.Comment = {
			commentId: ret.data.id,
			body: new vscode.MarkdownString(ret.data.body),
			userName: ret.data.user.login,
			gravatar: ret.data.user.avatar_url
		};

		let commentThread: vscode.CommentThread = {
			threadId: comment.commentId,
			resource: uri,
			range: range,
			comments: [comment]
		};

		return commentThread;
	};

	private async replyToCommentThread(_document: vscode.TextDocument, _range: vscode.Range, thread: vscode.CommentThread, text: string) {
		try {
			let ret = await this.element.createCommentReply(text, thread.threadId);
			thread.comments.push({
				commentId: ret.data.id,
				body: new vscode.MarkdownString(ret.data.body),
				userName: ret.data.user.login,
				gravatar: ret.data.user.avatar_url
			});
			return thread;
		} catch (e) {
			return null;
		}
	};

	private async provideDocumentComments(document: vscode.TextDocument, _token: vscode.CancellationToken): Promise<vscode.CommentInfo> {
		if (document.uri.scheme === 'pr') {
			let params = JSON.parse(document.uri.query);
			let isBase = params.base;
			let fileChange = this.richContentChanges.find(change => change.fileName === params.fileName);
			if (!fileChange) {
				return null;
			}

			let commentingRanges: vscode.Range[] = [];
			let diffHunks = fileChange.diffHunks;

			for (let i = 0; i < diffHunks.length; i++) {
				let diffHunk = diffHunks[i];
				if (isBase) {
					commentingRanges.push(new vscode.Range(diffHunk.oldLineNumber - 1, 0, diffHunk.oldLineNumber + diffHunk.oldLength - 1 - 1, 0));
				} else {
					commentingRanges.push(new vscode.Range(diffHunk.newLineNumber - 1, 0, diffHunk.newLineNumber + diffHunk.newLength - 1 - 1, 0));
				}
			}

			let matchingComments = this.commentsCache.get(fileChange.fileName);

			if (!matchingComments || !matchingComments.length) {
				return {
					threads: [],
					commentingRanges,
				};
			}

			let sections = groupBy(matchingComments, comment => String(comment.position));
			let threads: vscode.CommentThread[] = [];

			for (let i in sections) {
				let comments = sections[i];

				const comment = comments[0];
				// If the position is null, the comment is on a line that has been changed. Fall back to using original position.
				let diffLine = getDiffLineByPosition(fileChange.diffHunks, comment.position === null ? comment.original_position : comment.position);
				let commentAbsolutePosition = 1;
				if (diffLine) {
					commentAbsolutePosition = isBase ? diffLine.oldLineNumber : diffLine.newLineNumber;
				}

				if (commentAbsolutePosition < 0) {
					continue;
				}

				const pos = new vscode.Position(commentAbsolutePosition - 1, 0);
				const range = new vscode.Range(pos, pos);

				threads.push({
					threadId: comment.id,
					resource: document.uri,
					range,
					comments: comments.map(comment => {
						return {
							commentId: comment.id,
							body: new vscode.MarkdownString(comment.body),
							userName: comment.user.login,
							gravatar: comment.user.avatar_url
						};
					}),
					collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
				});
			}

			return {
				threads,
				commentingRanges,
			};

		}

		return null;
	}
}