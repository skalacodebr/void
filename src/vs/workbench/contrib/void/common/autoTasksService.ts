/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IChatThreadService } from '../browser/chatThreadService.js';
import { IVoidSettingsService } from './voidSettingsService.js';
import { Emitter } from '../../../../base/common/event.js';

export interface IAutoTasksService {
	readonly _serviceBrand: undefined;

	/**
	 * Importa tarefas de um arquivo JSON e inicia a execução
	 */
	importTasksFromFile(filePath: string): Promise<boolean>;

	/**
	 * Inicia a execução de tarefas
	 */
	startTaskExecution(): void;

	/**
	 * Para a execução de tarefas atual
	 */
	stopTaskExecution(): void;

	/**
	 * Verifica se há tarefas sendo executadas
	 */
	isExecuting(): boolean;

	/**
	 * Retorna o status atual da execução
	 */
	getExecutionStatus(): TaskExecutionStatus;
}

export interface AutoTask {
	id: string;
	prompt: string;
	description?: string;
	dependsOn?: string[];
	timeout?: number; // timeout in milliseconds
}

export interface TaskExecutionStatus {
	currentTaskId: string | null;
	executedTasks: string[];
	pendingTasks: string[];
	failedTasks: string[];
	isRunning: boolean;
}

export const IAutoTasksService = createDecorator<IAutoTasksService>('autoTasksService');

class AutoTasksService extends Disposable implements IAutoTasksService {
	_serviceBrand: undefined;

	private _tasks: AutoTask[] = [];
	private _executionStatus: TaskExecutionStatus = {
		currentTaskId: null,
		executedTasks: [],
		pendingTasks: [],
		failedTasks: [],
		isRunning: false
	};

	private readonly _onTasksImported = this._register(new Emitter<AutoTask[]>());
	private readonly _onTaskExecutionStarted = this._register(new Emitter<void>());
	private readonly _onTaskExecutionStopped = this._register(new Emitter<void>());
	private readonly _onTaskCompleted = this._register(new Emitter<string>());

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IChatThreadService private readonly chatThreadService: IChatThreadService,
		@IVoidSettingsService private readonly settingsService: IVoidSettingsService
	) {
		super();
	}

	async importTasksFromFile(filePath: string): Promise<boolean> {
		try {
			const fileContent = await this.fileService.readFile(URI.parse(filePath));
			const tasksData = JSON.parse(fileContent.value.toString());

			if (!Array.isArray(tasksData)) {
				console.error('O arquivo de tarefas deve conter um array de tarefas');
				return false;
			}

			this._tasks = tasksData;
			this._executionStatus.pendingTasks = this._tasks.map(task => task.id);
			this._executionStatus.executedTasks = [];
			this._executionStatus.failedTasks = [];

			this._onTasksImported.fire(this._tasks);
			return true;
		} catch (error) {
			console.error('Erro ao importar tarefas:', error);
			return false;
		}
	}

	startTaskExecution(): void {
		if (this._executionStatus.isRunning) {
			return;
		}

		if (this._tasks.length === 0) {
			console.warn('Não há tarefas para executar');
			return;
		}

		this._executionStatus.isRunning = true;
		this._onTaskExecutionStarted.fire();

		this.executeNextTask();
	}

	stopTaskExecution(): void {
		if (!this._executionStatus.isRunning) {
			return;
		}

		this._executionStatus.isRunning = false;
		this._executionStatus.currentTaskId = null;
		this._onTaskExecutionStopped.fire();
	}

	isExecuting(): boolean {
		return this._executionStatus.isRunning;
	}

	getExecutionStatus(): TaskExecutionStatus {
		return { ...this._executionStatus };
	}

	private async executeNextTask(): Promise<void> {
		if (!this._executionStatus.isRunning || this._executionStatus.pendingTasks.length === 0) {
			this.stopTaskExecution();
			return;
		}

		// Encontrar a próxima tarefa que não depende de tarefas não concluídas
		const nextTaskId = this.findNextExecutableTask();
		if (!nextTaskId) {
			console.warn('Não há tarefas executáveis disponíveis ou dependências não resolvidas');
			this.stopTaskExecution();
			return;
		}

		const task = this._tasks.find(t => t.id === nextTaskId);
		if (!task) {
			this.stopTaskExecution();
			return;
		}

		this._executionStatus.currentTaskId = task.id;
		this._executionStatus.pendingTasks = this._executionStatus.pendingTasks.filter(id => id !== task.id);

		try {
			// Usar o serviço de chat para executar a tarefa
			const threadId = this.chatThreadService.state.currentThreadId;

			// Adicionar a mensagem do usuário e aguardar a resposta
			await this.chatThreadService.addUserMessageAndStreamResponse({
				userMessage: task.prompt,
				threadId
			});

			// Marcar a tarefa como concluída
			this._executionStatus.executedTasks.push(task.id);
			this._onTaskCompleted.fire(task.id);

			// Agendar a próxima tarefa
			setTimeout(() => {
				this.executeNextTask();
			}, 1000); // Pequeno intervalo entre tarefas

		} catch (error) {
			console.error(`Erro ao executar tarefa ${task.id}:`, error);
			this._executionStatus.failedTasks.push(task.id);

			// Continuar com a próxima tarefa mesmo se houver falha
			setTimeout(() => {
				this.executeNextTask();
			}, 1000);
		}
	}

	private findNextExecutableTask(): string | null {
		for (const taskId of this._executionStatus.pendingTasks) {
			const task = this._tasks.find(t => t.id === taskId);
			if (!task) continue;

			// Verificar se todas as dependências foram executadas
			if (!task.dependsOn || task.dependsOn.length === 0) {
				return task.id;
			}

			const allDependenciesExecuted = task.dependsOn.every(depId =>
				this._executionStatus.executedTasks.includes(depId));

			if (allDependenciesExecuted) {
				return task.id;
			}
		}

		return null;
	}
}

registerSingleton(IAutoTasksService, AutoTasksService, InstantiationType.Delayed);
