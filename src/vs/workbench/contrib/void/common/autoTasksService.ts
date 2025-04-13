/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IVoidSettingsService } from './voidSettingsService.js';
import { Event, Emitter } from '../../../../base/common/event.js';

export interface IAutoTasksService {
	readonly _serviceBrand: undefined;

	/**
	 * Importa tarefas de um arquivo JSON
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

	/**
	 * Evento que é disparado quando uma tarefa precisa ser executada
	 */
	readonly onTaskReady: Event<AutoTask>;

	/**
	 * Notifica que uma tarefa foi concluída
	 */
	notifyTaskCompleted(taskId: string, success: boolean): void;
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
	private readonly _onTaskReady = this._register(new Emitter<AutoTask>());

	readonly onTaskReady = this._onTaskReady.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
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

		if (!this.settingsService.state.globalSettings.autoTasksEnabled) {
			console.warn('AutoTasks está desativado nas configurações');
			return;
		}

		if (this._tasks.length === 0) {
			console.warn('Não há tarefas para executar');
			return;
		}

		this._executionStatus.isRunning = true;
		this._onTaskExecutionStarted.fire();

		this.processNextTask();
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

	notifyTaskCompleted(taskId: string, success: boolean): void {
		if (!this._executionStatus.isRunning) {
			return;
		}

		if (success) {
			this._executionStatus.executedTasks.push(taskId);
			this._onTaskCompleted.fire(taskId);
		} else {
			this._executionStatus.failedTasks.push(taskId);
		}

		// Processar a próxima tarefa após um breve intervalo
		setTimeout(() => {
			this.processNextTask();
		}, 1000);
	}

	private processNextTask(): void {
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

		// Emitir evento para que um executor externo processe a tarefa
		this._onTaskReady.fire(task);
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
