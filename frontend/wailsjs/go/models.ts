export namespace config {
	
	export class Settings {
	    serverUrl: string;
	    apiKey: string;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.serverUrl = source["serverUrl"];
	        this.apiKey = source["apiKey"];
	    }
	}

}

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

export namespace officerapi {
	
	export class AttendanceResponse {
	    inserted: number;
	    unmatched: string[];
	
	    static createFrom(source: any = {}) {
	        return new AttendanceResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.inserted = source["inserted"];
	        this.unmatched = source["unmatched"];
	    }
	}
	export class BidEntry {
	    characterName: string;
	    tier: string;
	    occurredAt: string;
	
	    static createFrom(source: any = {}) {
	        return new BidEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.characterName = source["characterName"];
	        this.tier = source["tier"];
	        this.occurredAt = source["occurredAt"];
	    }
	}
	export class BidsResponse {
	    inserted: number;
	    unmatched: string[];
	    invalidTiers: string[];
	
	    static createFrom(source: any = {}) {
	        return new BidsResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.inserted = source["inserted"];
	        this.unmatched = source["unmatched"];
	        this.invalidTiers = source["invalidTiers"];
	    }
	}

}

