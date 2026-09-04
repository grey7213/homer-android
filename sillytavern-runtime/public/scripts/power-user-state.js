const fallbackPowerUserState = {
    experimental_macro_engine: true,
    personas: {},
    stscript: {
        parser: {
            flags: {},
        },
    },
};

let currentPowerUserState = fallbackPowerUserState;

/**
 * Registers the canonical power-user settings object once it has been created.
 * Keeping this tiny state bridge dependency-free prevents startup modules from
 * importing the full power-user module back through the slash-command graph.
 * @param {object} state Power-user settings object
 */
export function registerPowerUserState(state) {
    if (!state || typeof state !== 'object') {
        throw new TypeError('Power-user state must be an object.');
    }

    currentPowerUserState = state;
}

/**
 * Returns the live power-user settings object, or safe startup defaults before
 * power-user.js has finished evaluating.
 * @returns {object}
 */
export function getPowerUserState() {
    return currentPowerUserState;
}
