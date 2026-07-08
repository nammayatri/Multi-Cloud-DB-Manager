/**
 * Marks an error message as safe and useful to show directly to the user
 * (e.g. in a toast), as opposed to an unexpected internal failure whose raw
 * message might leak implementation details and should stay server-side only.
 */
export class ClickHouseUserError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ClickHouseUserError';
    }
}
