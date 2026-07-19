export class ArgumentError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ArgumentError';
    }
}

export function parseArguments(args, definition = {}) {
    const options = {};
    const positionals = [];
    const seen = new Set();
    const byName = new Map();
    for (const [key, option] of Object.entries(definition.options || {})) {
        for (const name of option.names || []) byName.set(name, { ...option, key });
    }

    let positionalOnly = false;
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (!positionalOnly && argument === '--') {
            positionalOnly = true;
            continue;
        }
        if (!positionalOnly && argument.startsWith('-')) {
            const equal = argument.indexOf('=');
            const name = equal > 0 ? argument.slice(0, equal) : argument;
            const inlineValue = equal > 0 ? argument.slice(equal + 1) : undefined;
            const option = byName.get(name);
            if (!option) throw new ArgumentError(`unknown option "${name}"`);
            if (seen.has(option.key)) {
                throw new ArgumentError(`option "${name}" may only be used once`);
            }
            seen.add(option.key);
            if (option.type === 'boolean') {
                if (inlineValue !== undefined) throw new ArgumentError(`option "${name}" does not take a value`);
                options[option.key] = true;
                continue;
            }
            let value = inlineValue;
            if (value === undefined) {
                value = args[++index];
                // Only treat the next token as a missing value when it is itself a
                // registered flag; otherwise accept it (e.g. --reason "- rotated key").
                if (value === undefined || (value.startsWith('-') && byName.has(value))) {
                    throw new ArgumentError(`missing value for ${name}`);
                }
            }
            if (!value && option.nonEmpty !== false) throw new ArgumentError(`missing value for ${name}`);
            if (option.choices && !option.choices.includes(value)) {
                throw new ArgumentError(`invalid value for ${name}: "${value}"`);
            }
            options[option.key] = value;
            continue;
        }
        positionals.push(argument);
    }

    for (const group of definition.conflicts || []) {
        const active = group.filter((key) => options[key] !== undefined && options[key] !== false);
        if (active.length > 1) throw new ArgumentError(`options conflict: ${active.join(', ')}`);
    }
    const minimum = definition.minPositionals ?? 0;
    const maximum = definition.maxPositionals ?? Infinity;
    if (positionals.length < minimum) throw new ArgumentError('missing required argument');
    if (positionals.length > maximum) throw new ArgumentError(`unexpected argument "${positionals[maximum]}"`);
    return { options, positionals };
}
