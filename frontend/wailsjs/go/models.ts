export namespace main {
	
	export class AttendanceResult {
	    occurredAt: string;
	    zone: string;
	    names: string[];
	    warnings: string[];
	
	    static createFrom(source: any = {}) {
	        return new AttendanceResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.occurredAt = source["occurredAt"];
	        this.zone = source["zone"];
	        this.names = source["names"];
	        this.warnings = source["warnings"];
	    }
	}
	export class BidRow {
	    characterName: string;
	    occurredAt: string;
	    tier: string;
	    ambiguous: boolean;
	    rawMessage: string;
	    superseded: boolean;
	
	    static createFrom(source: any = {}) {
	        return new BidRow(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.characterName = source["characterName"];
	        this.occurredAt = source["occurredAt"];
	        this.tier = source["tier"];
	        this.ambiguous = source["ambiguous"];
	        this.rawMessage = source["rawMessage"];
	        this.superseded = source["superseded"];
	    }
	}

}

