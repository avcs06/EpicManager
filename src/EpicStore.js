import "core-js/es/symbol";

import memoize from 'memoizee';
import invariant from 'invariant';
import { error, makeError } from './Errors';
import { initialValue, freeze, unfreeze, merge, MERGE_ERROR } from './Frozen';

function processCondition(currentError, condition, index) {
    if (condition.constructor === Array) {
        return condition.map(processCondition.bind(null, currentError));
    } else if (typeof condition === 'string') {
        condition = { type: condition };
    } else {
        condition = { ...condition };
    }

    const indexError = currentError(index);
    invariant(typeof condition.type === 'string', indexError('invalidConditionType'));

    const typeError = currentError(condition.type);
    if (condition.selector) {
        invariant(typeof condition.selector === 'function', typeError('invalidConditionSelector'));
        condition.selector = memoize(condition.selector, { max: 1 });
    } else {
        condition.selector = state => state;
    }

    if (!condition.hasOwnProperty('value')) {
        condition.value = initialValue;
    }

    return condition;
}

function splitConditions([...conditions]) {
    const conditionsList = [];
    conditions.some((condition, i) => {
        if (condition.constructor === Array) {
            condition.forEach(c => {
                conditions[i] = c;
                conditionsList.push(...splitConditions(conditions))
            });
            return true;
        }
        return false;
    });

    return conditionsList.length ? conditionsList : [conditions];
}

const validateAction = action => freeze(typeof action === 'string' ? { type: action } : action);

const getSelectorValue = ({ selector }, { type, payload }) => selector(payload, type);

const didConditionChange = condition => condition.hasOwnProperty('_value') && (condition._value !== condition.value);

const getHandlerParams = conditions => conditions.map(condition => {
    const value = condition.hasOwnProperty('_value') ? condition._value : condition.value;
    return value === initialValue ? undefined : value;
});

const getRegexFromPattern = pattern => new RegExp('^' + pattern.replace(/\*/g, '.*?') + '$');

const resetEpic = function (epic, shouldUpdate) {
    if (shouldUpdate) {
        epic.state = epic._state;
        epic.scope = epic._scope;
    }

    delete epic._state;
    delete epic._scope;
};

const resetCondition = function (shouldUpdate, condition) {
    if (shouldUpdate && condition.hasOwnProperty('_value')) {
        condition.value = condition._value;
    }
    delete condition._value;
    delete condition.matchedPattern;
}

export const createStore = ({ debug = false, patterns = false, undo = false, maxUndoStack = 10 }) => {
    const store = {};
    const epicRegistry = {};

    const updaterRegistry = {};
    const patternRegistry = {};

    const epicListeners = {};
    const patternListeners = {};

    let undoStack = [];
    let redoStack = [];

    const defaultEpicInstanceKey = Symbol('defaultEpicInstanceKey');
    const UNDO_ACTION = { type: 'STORE_UNDO' };
    const REDO_ACTION = { type: 'STORE_REDO' };

    store.register = function ({ name, state = initialValue, scope = initialValue, updaters = [], instance = false }) {
        let currentError = makeError(name);
        invariant(!epicRegistry[name], error('duplicateEpic', name));

        epicRegistry[name] = {
            state: freeze(state),
            scope: freeze(scope),
            updaters: updaters.map(({ conditions, handler }, index) => {
                currentError = currentError(index);
                conditions = conditions.map(processCondition.bind(null, currentError));
                return splitConditions(conditions).map(conditions => {
                    invariant(conditions.find(({ passive }) => !passive), currentError()('noPassiveUpdaters'));

                    const updater = { epic: name, handler, conditions, index };
                    conditions.forEach(({ type }) => {
                        let registry = updaterRegistry;
                        if (patterns && /\*/.test(type))
                            registry = patternRegistry;

                        if (!registry[type]) registry[type] = [];
                        registry[type].push(updater);
                    });

                    return updater;
                });
            })
        };

        if (instance) epicRegistry[name].instances = {};
    };

    store.unregister = function (epic) {
        const epicName = epic.name || epic;
        if (epicRegistry[epicName]) {
            delete epicRegistry[epicName];
            [updaterRegistry, patternRegistry].forEach(registry => {
                Object.keys(registry).forEach(condition => {
                    registry[condition] = registry[condition].filter(({ epic }) => epic !== epicName);
                });
            });
        }
    };

    const getInstances = epic => Object.keys(epic)
        .concat(epic[defaultEpicInstanceKey] ? defaultEpicInstanceKey : []);

    const processEpicListeners = (epicCache, sourceAction) => {
        const epicListenerCache = [];
        const postProcessingErrors = [];
        const updatedEpics = Object.keys(epicCache);
        updatedEpics.forEach(epicName => {
            let matchedPatterns = [];
            if (patterns) {
                Object.keys(patternListeners).forEach(key => {
                    if (getRegexFromPattern(key).test(epicName))
                        matchedPatterns.push(key);
                });
            }

            const epic = epicRegistry[epicName];
            getInstances(epicCache[epicName]).forEach(id => {
                const listeners = !epicListeners[epicName] ? [] :
                    (epicListeners[epicName][id] || epicListeners[epicName][defaultEpicInstanceKey] || []);

                matchedPatterns.forEach(key => {
                    listeners.push(
                        ...(patternListeners[key][id] || patternListeners[key][defaultEpicInstanceKey] || []));
                });

                listeners.forEach(listener => {
                    if (listener.processed) return;
                    listener.processed = true;
                    epicListenerCache.push(listener);

                    let hasRequired = false;
                    let hasChangedActive = false;
                    let hasUnchangedRequired = false;
                    const { conditions, handler } = listener;

                    conditions.forEach(condition => {
                        const { type, id, passive, required } = condition;
                        const epicChange = epicCache[type];
                        const payload = id ? epicChange[id] :
                            (epic.instances ? epicChange : epicChange[defaultEpicInstanceKey]);

                        if (patterns && /\*/.test(type)) {
                            const regex = getRegexFromPattern(type);
                            if (updatedEpics.some(key => regex.test(key) &&
                                (!id || epicCache[key][id]))) {
                                if (required) {
                                    hasRequired = true;
                                } else if (!passive) {
                                    hasChangedActive = true;
                                }
                            } else if (required) {
                                hasRequired = true;
                                hasUnchangedRequired = true;
                            }
                        } else if (payload) {
                            condition._value = getSelectorValue(condition, { type, payload });

                            if (required) {
                                hasRequired = true;
                                if (!didConditionChange(condition)) {
                                    hasUnchangedRequired = true;
                                }
                            } else if (!passive && didConditionChange(condition)) {
                                hasChangedActive = true;
                            }
                        } else if (required) {
                            hasRequired = true;
                            hasUnchangedRequired = true;
                        }
                    });

                    // If there are required conditions all of them should change,
                    // else at least one active condition should change
                    if (hasRequired ? !hasUnchangedRequired : hasChangedActive) {
                        try {
                            handler(getHandlerParams(conditions), { sourceAction });
                        } catch (e) {
                            postProcessingErrors.push(e);
                        }
                    }
                });
            });
        });

        epicListenerCache.forEach(listener => {
            listener.conditions.forEach(resetCondition.bind(null, true));
            delete listener.processed;
        });

        return errors;
    };

    store.dispatch = (() => {
        let sourceAction, epicCache, actionCache, conditionCache, inCycle, afterCycle, undoEntry;

        const makeHandleUpdate = (instance, update) => (entity, callback = Function.prototype) => {
            if (update.hasOwnProperty(entity)) {
                let updatedEntity, undoChange, redoChange;
                try {
                    [updatedEntity, undoChange, redoChange] =
                        merge(unfreeze(instance['_' + entity]), update[entity]);
                } catch (e) {
                    invariant(e !== MERGE_ERROR,
                        error('invalidHandlerUpdate', epicName, index));
                    throw e;
                }

                instance['_' + entity] = freeze(updatedEntity);
                if (undo) {
                    undoEntry[epicName] = {
                        ...(undoEntry[epicName] || {}),
                        [id]: {
                            ...(undoEntry[epicName][id] || {}),
                            [entity]: { undo: undoChange, redo: redoChange }
                        }
                    };
                }

                callback();
            }
        };

        const processUpdater = function (action, activeCondition, updater, forcePassiveUpdate) {
            const { epic: epicName, conditions, handler, index } = updater;

            // If this is passive action
            // there should be atleast one non passive condition whose value changed
            // if not dont update the epic
            if (activeCondition.passive && !conditions.some(condition => (
                !condition.passive && (condition.matchedPattern || didConditionChange(condition))
            ))) return;

            // if all active conditions are not changed, dont update the epic
            // PS: activeCondition doesnt need to change if it is external
            if (!conditions.every(condition => (
                condition === activeCondition ||
                condition.passive || !condition.required ||
                condition.matchedPattern || didConditionChange(condition)
            ))) return;

            let instances;
            const epic = epicRegistry[epicName];
            if (!epic.instances) {
                instances = [[epic, defaultEpicInstanceKey]];
            } else if (action.target) {
                if (!epic.instances[action.target]) {
                    epic.instances[action.target] = {
                        state: freeze(unfreeze(epic.state)),
                        scope: freeze(unfreeze(epic.scope)),
                    }
                }
                instances = [[epic.instances[action.target], action.target]];
            } else {
                instances = Object.keys(epic.instances).map(key => [epic.instances[key], key]);
            }

            instances.forEach(([instance, id]) => {
                instance._state = instance.hasOwnProperty('_state') ? instance._state : instance.state;
                instance._scope = instance.hasOwnProperty('_scope') ? instance._scope : instance.scope;

                const handlerUpdate = handler(getHandlerParams(conditions), {
                    state: instance.state, currentCycleState: instance._state,
                    scope: instance.scope, currentCycleScope: instance._scope,
                    sourceAction, currentAction: action
                });

                const handleUpdate = makeHandleUpdate(instance, handlerUpdate);
                handleUpdate(scope);
                handleUpdate(state, () => {
                    if (!forcePassiveUpdate && !handlerUpdate.passive) {
                        processAction({ type: epicName, payload: instance._state });
                    }
                });

                if (handlerUpdate.hasOwnProperty('actions')) {
                    handlerUpdate.actions.forEach(
                        action => processAction(validateAction(action), true));
                }
            });
        };

        const processAction = (action, external) => {
            invariant(!external || !epicRegistry[action.type], error('invalidEpicAction', action.type));
            invariant(!external || !actionCache.hasOwnProperty(action.type), error('noRepeatedExternalAction', action.type));
            actionCache[action.type] = action.payload;

            // handle direct updaters
            (updaterRegistry[action.type] || []).forEach(function ({ conditions }) {
                const activeCondition = conditions.find(({ type }) => action.type === type);
                activeCondition._value = getSelectorValue(activeCondition, action);
                conditionCache.push(activeCondition);

                // If this is not external action and condition value didnt change, dont update the epic
                if (!external && !didConditionChange(activeCondition)) return;
                processUpdater(action, activeCondition, arguments[0]);
            });

            // handle pattern updaters
            if (patterns) {
                Object.keys(patternRegistry).forEach(key => {
                    const regex = getRegexFromPattern(key);
                    if (regex.test(action.type)) {
                        patternRegistry[key].forEach(function ({ conditions }) {
                            const activeCondition = conditions.find(({ type }) => key === type);
                            activeCondition.matchedPattern = true;
                            conditionCache.push(activeCondition);

                            processUpdater(action, activeCondition, arguments[0], key === '*');
                        });
                    }
                });
            }
        };

        return function (action) {
            // validate action
            action = validateAction(action);

            // Handle external actions during cycle
            if (inCycle) return processAction(action, true);
            // No actions should be dispatched from epic listeners
            invariant(!afterCycle, error('noDispatchInEpicListener'));

            // Fresh dispatch cycle
            inCycle = true;
            undoEntry = {};
            epicCache = {};
            actionCache = {};
            conditionCache = [];
            sourceAction = action;
            epicListenerCache = [];

            // dipatch cycle
            let processingError;
            try {
                processAction(action, true);
            } catch (e) {
                processingError = e;
            }

            // End of dispatch cycle
            inCycle = false;
            afterCycle = true;

            // handle epic listeners
            const postProcessingErrors = processEpicListeners(epicCache, sourceAction);

            // Update or reset conditions
            conditionCache.forEach(resetCondition.bind(null, !processingError));

            // Update or reset epics
            Object.keys(epicCache).forEach(epicName => {
                const epic = epicRegistry[epicName];
                if (!epic.instances) {
                    resetEpic(epic, !processingError);
                } else {
                    Object.keys(epicCache[epicName]).forEach(id => {
                        resetEpic(epic[id], !processingError);
                    });
                }
            });

            if (undo && !processingError) {
                if (undoStack.length === maxUndoStack)
                    undoStack.shift();
    
                undoStack.push(undoEntry);
                redoStack = [];
            }

            afterCycle = false;

            // After everything is reset throw the caught errors
            if (processingError) {
                throw processingError;
            }
            if (postProcessingErrors.length) {
                throw postProcessingErrors;
            }
        };
    })();

    store.addListener = function (conditions, handler) {
        conditions = conditions.map(processCondition.bind(null, makeError()()));
        const epicListener = { conditions, handler };
        const cache = conditions.map(({ type, target = defaultEpicInstanceKey }) => {
            let listeners = epicListeners;
            if (patterns && /\*/.test(type)) listeners = patternListeners;
            if (!listeners[type]) listeners[type] = {};
            if (!listeners[type][target]) listeners[type][target] = [];

            listeners[type][target].push(epicListener) - 1;
            return { listeners, type, target };
        });

        return () => {
            cache.forEach(({ listeners, type, target }) => {
                listeners[type][target] =
                    listeners[type][target].filter(listener => listener !== epicListener);
            });
        };
    };

    if (undo) {
        const handleChange = function (from, to, key) {
            const entry = from.pop();
            const epicCache = {};

            Object.keys(entry).forEach(epicName => {
                const epic = epicRegistry[epicName];
                epicCache[epicName] = {};

                getInstances(entry[epicName]).forEach(id => {
                    const instance = id === defaultEpicInstanceKey ? epic : epic.instances[id];
                    epicCache[epicName][id] = instance.state = freeze(entry[epicName][id][key](unfreeze(instance.state)));
                });
            });

            to.push(entry);
            return epicCache;
        };

        store.undo = function () {
            const epicCache = handleChange(undoStack, redoStack, 'undo');
            processEpicListeners(epicCache, UNDO_ACTION);
        };

        store.redo = function () {
            const epicCache = handleChange(redoStack, undoStack, 'redo');
            processEpicListeners(epicCache, REDO_ACTION);
        };
    }

    if (debug) {
        const getEpic = function (epicName, key) {
            const epic = epicRegistry[epicName];
            return epic ? epic[key] : null;
        };

        store.getEpicState = function (epicName) {
            return getEpic(epicName, 'state');
        };

        store.getEpicScope = function (epicName) {
            return getEpic(epicName, 'scope');
        };

        store.getEpicUpdaters = function (epicName, index) {
            return getEpic(epicName, 'updaters')[index].map(({ conditions }) => ({
                conditions: conditions.map(condition => ({ ...condition }))
            }));
        };

        store.getEpicListeners = function (conditionType, target = defaultEpicInstanceKey) {
            return [...epicListeners[conditionType][target].map(({ conditions }) => ({
                conditions: conditions.map(condition => ({ ...condition }))
            }))];
        };
    }

    return store;
};
