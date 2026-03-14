/**
 * Maps PostgreSQL column data types to ClickHouse data types.
 * Rules confirmed:
 *  - uuid    → String / Nullable(String)
 *  - boolean → String / Nullable(String)
 *  - All other types mapped per the table below.
 */
export class ClickHouseTypeMapper {
    /**
     * Map a PostgreSQL data_type (from information_schema.columns) to a
     * ClickHouse type string.
     *
     * @param pgDataType  - The "data_type" column value from information_schema
     * @param pgUdtName   - The "udt_name" column value (useful for arrays, enums)
     * @param isNullable  - Whether the column allows NULLs ("YES" | "NO")
     */
    public static map(pgDataType: string, pgUdtName: string, isNullable: string): string {
        const nullable = isNullable === 'YES';
        const ldt = pgDataType.toLowerCase();
        const ludt = pgUdtName.toLowerCase();

        // Arrays: nullability applies to the element type, not the array container itself.
        // e.g. PG nullable int[] → Array(Nullable(Int32))
        //      PG NOT NULL text[] → Array(String)
        if (ludt.startsWith('_') || ldt === 'array') {
            // Derive the element PG type by stripping the leading underscore from udt_name
            // (e.g. _int4 → int4, _text → text). Fall back to String for unknown types.
            const elemUdt = ludt.startsWith('_') ? ludt.slice(1) : ludt;
            const elemBase = this.scalarBase(elemUdt) ?? 'String';
            return nullable ? `Array(Nullable(${elemBase}))` : `Array(${elemBase})`;
        }

        const baseType = this.scalarBase(ldt) ?? this.scalarBase(ludt) ?? 'String';
        return nullable ? `Nullable(${baseType})` : baseType;
    }

    /**
     * Map a single scalar PG type keyword to a CH base type.
     * Returns null for unknown types (caller falls back to 'String').
     * Does NOT handle arrays or nullability — those are handled in map().
     */
    private static scalarBase(pgType: string): string | null {
        switch (pgType) {
            // --- UUIDs and booleans → String ---
            case 'uuid': return 'String';
            case 'boolean': return 'String';
            case 'bool': return 'String';

            // --- Text types ---
            case 'text':
            case 'character varying':
            case 'varchar':
            case 'character':
            case 'char':
            case 'bpchar':         // internal name for char in PG
            case 'name':
            case 'citext':
            case 'tsvector':
            case 'tsquery':
            case 'xml':
            case 'inet':
            case 'cidr':
            case 'macaddr':
            case 'point':
            case 'path':
            case 'polygon':
            case 'line':
            case 'lseg':
            case 'box':
            case 'circle': return 'String';

            // --- Integer types ---
            case 'smallint':
            case 'int2': return 'Int16';
            case 'integer':
            case 'int':
            case 'int4': return 'Int32';
            case 'bigint':
            case 'int8': return 'Int64';

            // --- Floating point ---
            case 'real':
            case 'float4': return 'Float32';
            case 'double precision':
            case 'float8': return 'Float64';

            // --- Decimal / money → Float64 ---
            // Using Float64 avoids Decimal precision mismatches and is
            // sufficient for analytics workloads.
            case 'numeric':
            case 'decimal':
            case 'money': return 'Float64';

            // --- Date/time ---
            case 'timestamp without time zone':
            case 'timestamp':
            case 'timestamptz':
            case 'timestamp with time zone': return 'DateTime';
            case 'date': return 'Date';
            case 'time without time zone':
            case 'time with time zone':
            case 'time':
            case 'interval': return 'String';

            // --- JSON → stored as raw String ---
            case 'json':
            case 'jsonb': return 'String';

            // --- Binary ---
            case 'bytea': return 'String';

            // --- Serial / sequences ---
            case 'smallserial': return 'Int16';
            case 'serial': return 'Int32';
            case 'bigserial': return 'Int64';

            // --- Enums and user-defined ---
            case 'user-defined': return 'String';

            default: return null;
        }
    }

    /**
     * Returns true if the given CH base type is a DateTime-family type.
     * Used by DDLBuilder to detect the primary datetime column.
     */
    public static isDateTimeType(chBaseType: string): boolean {
        return chBaseType === 'DateTime' || chBaseType === 'Date';
    }
}

export default ClickHouseTypeMapper;
