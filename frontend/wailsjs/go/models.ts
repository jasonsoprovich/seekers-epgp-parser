export namespace config {
	
	export class Settings {
	    apiKey: string;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
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
	export class LedgerPage {
	    rows: officerapi.LedgerRow[];
	    hasNext: boolean;
	
	    static createFrom(source: any = {}) {
	        return new LedgerPage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.rows = this.convertValues(source["rows"], officerapi.LedgerRow);
	        this.hasNext = source["hasNext"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class PointValues {
	    ep: officerapi.PointValue[];
	    gp: officerapi.PointValue[];
	
	    static createFrom(source: any = {}) {
	        return new PointValues(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ep = this.convertValues(source["ep"], officerapi.PointValue);
	        this.gp = this.convertValues(source["gp"], officerapi.PointValue);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
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
	    isWinner: boolean;
	
	    static createFrom(source: any = {}) {
	        return new BidEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.characterName = source["characterName"];
	        this.tier = source["tier"];
	        this.occurredAt = source["occurredAt"];
	        this.isWinner = source["isWinner"];
	    }
	}
	export class BidsResponse {
	    lootEventId: number;
	    inserted: number;
	    unmatched: string[];
	    invalidTiers: string[];
	
	    static createFrom(source: any = {}) {
	        return new BidsResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.lootEventId = source["lootEventId"];
	        this.inserted = source["inserted"];
	        this.unmatched = source["unmatched"];
	        this.invalidTiers = source["invalidTiers"];
	    }
	}
	export class Character {
	    id: number;
	    name: string;
	    charType: string;
	    mainCharacterId?: number;
	    status: string;
	    mainCharacterName?: string;
	    priorityRating?: number;
	
	    static createFrom(source: any = {}) {
	        return new Character(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.charType = source["charType"];
	        this.mainCharacterId = source["mainCharacterId"];
	        this.status = source["status"];
	        this.mainCharacterName = source["mainCharacterName"];
	        this.priorityRating = source["priorityRating"];
	    }
	}
	export class LedgerRow {
	    id: number;
	    characterName: string;
	    occurredAt: string;
	    activity?: string;
	    itemName?: string;
	    tier?: string;
	    points: number;
	    note?: string;
	    source: string;
	    enteredByName?: string;
	
	    static createFrom(source: any = {}) {
	        return new LedgerRow(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.characterName = source["characterName"];
	        this.occurredAt = source["occurredAt"];
	        this.activity = source["activity"];
	        this.itemName = source["itemName"];
	        this.tier = source["tier"];
	        this.points = source["points"];
	        this.note = source["note"];
	        this.source = source["source"];
	        this.enteredByName = source["enteredByName"];
	    }
	}
	export class ManualEntryRequest {
	    kind: string;
	    characterId: number;
	    activity?: string;
	    tier?: string;
	    itemName?: string;
	    points: number;
	    occurredAt: string;
	    note: string;
	
	    static createFrom(source: any = {}) {
	        return new ManualEntryRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.characterId = source["characterId"];
	        this.activity = source["activity"];
	        this.tier = source["tier"];
	        this.itemName = source["itemName"];
	        this.points = source["points"];
	        this.occurredAt = source["occurredAt"];
	        this.note = source["note"];
	    }
	}
	export class PointValue {
	    activity: string;
	    points: number;
	
	    static createFrom(source: any = {}) {
	        return new PointValue(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.activity = source["activity"];
	        this.points = source["points"];
	    }
	}
	export class TotalsRow {
	    id: number;
	    name: string;
	    charType: string;
	    status: string;
	    mainCharacterName?: string;
	    ep?: number;
	    gp?: number;
	    epDecay?: number;
	    gpDecay?: number;
	    priorityRating?: number;
	
	    static createFrom(source: any = {}) {
	        return new TotalsRow(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.charType = source["charType"];
	        this.status = source["status"];
	        this.mainCharacterName = source["mainCharacterName"];
	        this.ep = source["ep"];
	        this.gp = source["gp"];
	        this.epDecay = source["epDecay"];
	        this.gpDecay = source["gpDecay"];
	        this.priorityRating = source["priorityRating"];
	    }
	}

}

