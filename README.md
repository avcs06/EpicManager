<p align="center">
  <img src="https://github.com/avcs06/Ricochet/blob/master/ricochet.jpg?raw=true">
</p>

Ricochet is an event based state management framework. Epic is a basic building block of Ricochet. Each Epic is a state, it listens for User Actions or changes in other Epics and updates it's own state. User can subscribe to changes in Epic directly.

## Store
Store is the place where Epics and Listeners can be registered.

```
const { createStore } = require('@avcs/ricochet');

// Instantiate Store
const appStore = createStore({ patterns: false, undo: false });
```

## Epic
Epic is a state, it can register reducers that reduce it's own state when a specific condition is met
* **State:** Current state of the epic
* **Scope:** Any additional information that is not needed to be exposed by the epic, but is needed to compute the state.

```
const { makeEpic } = require('@avcs/ricochet');

// Instantiate Epic
const sampleEpic = makeEpic(name);
sampleEpic.useState(initialState)
sampleEpic.useScope(initialScope)
sampleEpic.useReducer(condition, handler)

// Register or unregister an Epic
appStore.register(sampleEpic);
appStore.unregister(sampleEpic);
```

## Reducer
An Epic uses reducers to listen to actions and reduce it's state.

> PS: This is different from a listener, a listener listens for changes in Epics and executes the handler. A reducer listens for actions or changes in other Epics and updates the state of Epic it belongs to.

* ***Reducer handler SHOULD BE a pure function.***
* An Reducer handler can either update state or scope of the epic it is linked to or dispatch more actions or both.
* Use scope for passing information among reducers of same epic.
* Number of executions of a reducer handler is not gauranteed to one per cycle.

```
// Register a Reducer
const removeReducer = sampleEpic.useReducer('SampleAction', payload => {
    return {
        state?: stateChange,
        scope?: scopeChange,
        actions?: ['SideAffect']
    };
});
// removeReducer() can be used to unregister the Reducer
```

## Action
Actions can be dispatched through store and can be listened by Epics in Reducers. There are two types of actions:

* **User Action:**
  An action that is dispatched by the application, actions dispatched by "actions" property of Reducer return are also considered User Actions.
* **Epic Action:**
  An action that is dispatched internally, when an epic is updated.
> Registered Epics cannot be dispatched as User Action

**Action.target**
An action can have a target property that mentions which Epic should be targeted, if there are other epics listening to same action, they won't be updated if the target doesn't match.

```
// Dispatching an Action
appStore.dispatch('SampleAction');
appStore.dispatch({ type: 'SampleAction', payload?, target?, createUndoPoint?, skipUndoPoint? });
```

## Condition
Reducers and listeners, listen to conditions which gives more functionalities than actions.

* A Reducer handler will be executed when all the Conditions are fulfilled in the same Epic Cycle.
* **type:** Action type the Condition should listen on
* **readonly:** Readonly condition does not execute the handler when it's respective action is dispatched, but the handler will receive the latest payload if all other conditions of the reducer have been met.
* A reducer should have at least one non readonly condition.
* Only Epic Conditions can be used as readonly conditions, User Conditions will ignore readonly property.
* **selector:** A function to select the part or whole of payload that is needed by this condition.
* An Epic condition is fulfilled if the value returned by selector is different from its prev value. If a new action has been dispatched but the part of the payload that the condition depends on is not changed then the condition will not be fulfilled.
* **guard:** A function that says whether current selector value can trigger the change or not
* ***Selector functions SHOULD BE pure functions*** (number of executions is not gauranteed to one per cycle).
* **AnyOf Condition:** The handler will be executed when any of the conditions in AnyOf is met, the handler will be executed once per each fulfilled condition in AnyOf in a single cycle.
* **Pattern Conditions:** Conditions can have patterns as their types using the wild card `*`, such conditions will be met if the dispatched action type matches the pattern.
* AnyActionPattern (`*`) when used as a condition, will not dispatch the updated epic as action, as this can lead to cyclic dependencies.
* **Resolvable Conditions:** A Reducer can listen on multiple conditions simultaneously, the handler will be executed when all the Conditions are met. For passing multiple conditions, they can be passed as either an Array or Object using resolve(), condition values will be passed to the handler in the same format passed to resolve method.

```
const { anyOf, readonly, resolve } = require('@avcs/epicstore');

// AnyOf condition
sampleEpic.useReducer(anyOf(c1, c2, c3), handler);

// Pattern condition
sampleEpic.useReducer('c*', handler);

// readonly condition
sampleEpic.useReducer(readonly('SampleAction'), handler);

// resolve condition
sampleEpic.useReducer(resolve(['c1', 'c2']), ([c1Payload, c2Payload]) => {});
sampleEpic.useReducer(resolve({ c1: 'c1', c2: 'c2' }), ({ c1, c2 }) => {});

// string format condition
sampleEpic.useReducer(resolve(['readonly:epic1.a.b.c', 'epic2.a']), ([c, a] => {});
```

## Listener
The application can directly listen to changes in epics through Listener. Listeners are executed only after the epic cycle is completed and they ***SHOULD NOT*** dispatch new actions.

```
// Register a listener on store
const removeListener = appStore.addListener('sampleEpic', handler);
// removeListener() can be used to unregister the Listener
```

## Epic cycle
Whenever an epic is updated, an internal action is dispatched with epicname as type and new epic state as payload and any reducers listening to this epic will be executed in the same cycle if conditions are met.
Which in turn can trigger simillar reaction, all the updates happened until no more actions are dispatched are considered to be one EPIC cycle.

* An epic cycle always starts with a User action.
* User actions dispatched during an epic cycle will be considered part of the cycle.
* Any listeners will be informed of change in the epics only after the epic cycle is completed
* If any unhandled error occurs while processing an epic cycle, all the epics that were updated during this cycle will be reset to the values before this cycle started.

## Scope?
Scope can be considered as a normal shared scope among handlers with one additional feature, whenever the epic cycle fails all the variables inside this scope will be reverted to last known safe values.
