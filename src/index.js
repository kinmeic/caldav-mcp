import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import pkg from 'tsdav';
const { createDAVClient, createAccount, fetchCalendars, fetchCalendarObjects, getBasicAuthHeaders, freeBusyQuery } = pkg;
import * as dotenv from 'dotenv';
import ICAL from 'ical.js';
import { randomUUID } from 'crypto';

dotenv.config();

const CALDAV_URL = process.env.CALDAV_URL;
const CALDAV_USERNAME = process.env.CALDAV_USERNAME;
const CALDAV_PASSWORD = process.env.CALDAV_PASSWORD;

class CalDAVServer {
  constructor() {
    this.server = new Server(
      {
        name: 'caldav-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.client = null;
    this.account = null;
    this.calendars = null;
    this.authHeaders = null;
    this.setupHandlers();
  }

  // Helper to make authenticated requests
  async davRequest(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        ...this.authHeaders,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status} ${response.statusText}: ${text}`);
    }
    return response;
  }

  // Parse CalDAV multi-status response
  parseMultiStatus(xml) {
    const results = [];
    // Match href - without namespace prefix (the server returns <href> not <D:href>)
    const hrefRegex = /<href>([^<]+)<\/href>/g;
    // Match calendar-data - needs to handle multi-line content
    const dataRegex = /<C:calendar-data>([\s\S]*?)<\/C:calendar-data>/g;

    const matches = [];
    let match;

    while ((match = hrefRegex.exec(xml)) !== null) {
      matches.push({ type: 'href', value: match[1], index: match.index });
    }
    while ((match = dataRegex.exec(xml)) !== null) {
      matches.push({ type: 'data', value: match[1], index: match.index });
    }

    matches.sort((a, b) => a.index - b.index);

    let currentHref = null;
    for (const m of matches) {
      if (m.type === 'href') {
        currentHref = decodeURIComponent(m.value);
      } else if (m.type === 'data' && currentHref) {
        results.push({ url: currentHref, icalString: m.value });
        currentHref = null;
      }
    }

    return results;
  }

  // List calendar objects using REPORT
  async listCalendarObjects(calendarUrl, startDate, endDate, componentName = 'VCALENDAR') {
    const formatDate = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    let filter;
    if (componentName === 'VTODO') {
      filter = `<C:filter><C:comp-filter name="VTODO"/></C:filter>`;
    } else {
      filter = `<C:filter><C:comp-filter name="VCALENDAR"><C:time-range start="${formatDate(startDate)}" end="${formatDate(endDate)}"/></C:comp-filter></C:filter>`;
    }

    const propfindBody = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  ${filter}
</C:calendar-query>`;

    const response = await this.davRequest(calendarUrl, {
      method: 'REPORT',
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Depth': '1',
      },
      body: propfindBody,
    });

    const text = await response.text();
    return this.parseMultiStatus(text);
  }

  ensureAbsoluteUrl(calendarUrl, relativeUrl) {
    if (relativeUrl.startsWith('http')) return relativeUrl;
    // Get server base URL from calendar URL
    const match = calendarUrl.match(/^(https?:\/\/[^/]+)\//);
    const serverBase = match ? match[1] : CALDAV_URL.replace(/\/caldav.*$/, '');
    // Remove leading slash from relative URL if present
    const cleanRelative = relativeUrl.startsWith('/') ? relativeUrl.substring(1) : relativeUrl;
    return serverBase + '/' + cleanRelative;
  }

  async initialize() {
    try {
      // Generate Basic auth header manually
      this.authHeaders = getBasicAuthHeaders({
        username: CALDAV_USERNAME,
        password: CALDAV_PASSWORD,
      });

      // Pass auth headers directly to createAccount
      const account = await createAccount({
        account: {
          accountType: 'caldav',
          serverUrl: CALDAV_URL,
          credentials: {
            username: CALDAV_USERNAME,
            password: CALDAV_PASSWORD,
          },
        },
        headers: this.authHeaders,
        loadCollections: true,
      });

      this.account = account;
      this.client = account.client;
      this.calendars = account.calendars || [];

      console.error('Connected to CalDAV server, found', this.calendars.length, 'calendars');
    } catch (error) {
      console.error('Failed to connect to CalDAV server:', error.message);
    }
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'list_calendars',
            description: 'List all available calendars from the CalDAV server',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'list_events',
            description: 'List events from a specific calendar within a date range',
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: {
                  type: 'string',
                  description: 'The calendar ID (use list_calendars to get this)',
                },
                start_date: {
                  type: 'string',
                  description: 'Start date in ISO format (e.g., 2024-01-01)',
                },
                end_date: {
                  type: 'string',
                  description: 'End date in ISO format (e.g., 2024-01-31)',
                },
              },
              required: ['calendar_id', 'start_date', 'end_date'],
            },
          },
          {
            name: 'get_event',
            description: 'Get a specific event by its ID',
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: {
                  type: 'string',
                  description: 'The calendar ID',
                },
                event_id: {
                  type: 'string',
                  description: 'The event ID (UID)',
                },
              },
              required: ['calendar_id', 'event_id'],
            },
          },
          {
            name: 'create_event',
            description: 'Create a new calendar event',
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: {
                  type: 'string',
                  description: 'The calendar ID',
                },
                title: {
                  type: 'string',
                  description: 'Event title/summary',
                },
                description: {
                  type: 'string',
                  description: 'Event description',
                },
                start_date: {
                  type: 'string',
                  description: 'Start date and time in ISO format (e.g., 2024-01-15T10:00:00)',
                },
                end_date: {
                  type: 'string',
                  description: 'End date and time in ISO format (e.g., 2024-01-15T11:00:00)',
                },
                location: {
                  type: 'string',
                  description: 'Event location (optional)',
                },
              },
              required: ['calendar_id', 'title', 'start_date', 'end_date'],
            },
          },
          {
            name: 'update_event',
            description: 'Update an existing calendar event',
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: {
                  type: 'string',
                  description: 'The calendar ID',
                },
                event_id: {
                  type: 'string',
                  description: 'The event ID (UID) to update',
                },
                title: {
                  type: 'string',
                  description: 'Event title/summary',
                },
                description: {
                  type: 'string',
                  description: 'Event description',
                },
                start_date: {
                  type: 'string',
                  description: 'Start date and time in ISO format',
                },
                end_date: {
                  type: 'string',
                  description: 'End date and time in ISO format',
                },
                location: {
                  type: 'string',
                  description: 'Event location (optional)',
                },
              },
              required: ['calendar_id', 'event_id'],
            },
          },
          {
            name: 'delete_event',
            description: 'Delete a calendar event',
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: {
                  type: 'string',
                  description: 'The calendar ID',
                },
                event_id: {
                  type: 'string',
                  description: 'The event ID (UID) to delete',
                },
              },
              required: ['calendar_id', 'event_id'],
            },
          },
          // Task (VTODO) tools
          {
            name: 'list_todos',
            description: 'List tasks (VTODO) from a specific calendar',
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: {
                  type: 'string',
                  description: 'The calendar ID (use list_calendars to get this)',
                },
              },
              required: ['calendar_id'],
            },
          },
          {
            name: 'get_todo',
            description: 'Get a specific task by its ID',
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: {
                  type: 'string',
                  description: 'The calendar ID',
                },
                todo_id: {
                  type: 'string',
                  description: 'The task ID (UID)',
                },
              },
              required: ['calendar_id', 'todo_id'],
            },
          },
          {
            name: 'create_todo',
            description: 'Create a new task (VTODO)',
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: {
                  type: 'string',
                  description: 'The calendar ID',
                },
                title: {
                  type: 'string',
                  description: 'Task title/summary',
                },
                description: {
                  type: 'string',
                  description: 'Task description',
                },
                due_date: {
                  type: 'string',
                  description: 'Due date in ISO format (e.g., 2024-01-20T23:59:00)',
                },
                priority: {
                  type: 'string',
                  description: 'Priority: 1 (high), 5 (medium), 9 (low), or 0 (none)',
                },
                status: {
                  type: 'string',
                  description: 'Status: NEEDS-ACTION, IN-PROCESS, COMPLETED, CANCELLED',
                },
              },
              required: ['calendar_id', 'title'],
            },
          },
          {
            name: 'update_todo',
            description: 'Update an existing task',
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: {
                  type: 'string',
                  description: 'The calendar ID',
                },
                todo_id: {
                  type: 'string',
                  description: 'The task ID (UID) to update',
                },
                title: {
                  type: 'string',
                  description: 'Task title/summary',
                },
                description: {
                  type: 'string',
                  description: 'Task description',
                },
                due_date: {
                  type: 'string',
                  description: 'Due date in ISO format',
                },
                priority: {
                  type: 'string',
                  description: 'Priority: 1 (high), 5 (medium), 9 (low), or 0 (none)',
                },
                status: {
                  type: 'string',
                  description: 'Status: NEEDS-ACTION, IN-PROCESS, COMPLETED, CANCELLED',
                },
              },
              required: ['calendar_id', 'todo_id'],
            },
          },
          {
            name: 'delete_todo',
            description: 'Delete a task',
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: {
                  type: 'string',
                  description: 'The calendar ID',
                },
                todo_id: {
                  type: 'string',
                  description: 'The task ID (UID) to delete',
                },
              },
              required: ['calendar_id', 'todo_id'],
            },
          },
          // Advanced tools
          {
            name: 'find_free_busy',
            description: 'Find free time slots within a date range',
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: {
                  type: 'string',
                  description: 'The calendar ID',
                },
                start_date: {
                  type: 'string',
                  description: 'Start date in ISO format',
                },
                end_date: {
                  type: 'string',
                  description: 'End date in ISO format',
                },
              },
              required: ['calendar_id', 'start_date', 'end_date'],
            },
          },
          {
            name: 'check_conflict',
            description: 'Check if there is a time conflict with existing events',
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: {
                  type: 'string',
                  description: 'The calendar ID',
                },
                start_date: {
                  type: 'string',
                  description: 'Start date in ISO format',
                },
                end_date: {
                  type: 'string',
                  description: 'End date in ISO format',
                },
              },
              required: ['calendar_id', 'start_date', 'end_date'],
            },
          },
          {
            name: 'search_events',
            description: 'Search events by title or description keyword',
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: {
                  type: 'string',
                  description: 'The calendar ID',
                },
                query: {
                  type: 'string',
                  description: 'Search keyword',
                },
              },
              required: ['calendar_id', 'query'],
            },
          },
          {
            name: 'create_recurring_event',
            description: 'Create a recurring event with RRULE',
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: {
                  type: 'string',
                  description: 'The calendar ID',
                },
                title: {
                  type: 'string',
                  description: 'Event title/summary',
                },
                description: {
                  type: 'string',
                  description: 'Event description',
                },
                start_date: {
                  type: 'string',
                  description: 'Start date and time in ISO format',
                },
                end_date: {
                  type: 'string',
                  description: 'End date and time in ISO format',
                },
                location: {
                  type: 'string',
                  description: 'Event location (optional)',
                },
                rrule: {
                  type: 'string',
                  description: 'Recurrence rule (e.g., FREQ=WEEKLY;BYDAY=MO,WE,FR or FREQ=DAILY;COUNT=10 or FREQ=MONTHLY;BYDAY=1FR)',
                },
              },
              required: ['calendar_id', 'title', 'start_date', 'end_date', 'rrule'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'list_calendars':
            return await this.listCalendars();
          case 'list_events':
            return await this.listEvents(args);
          case 'get_event':
            return await this.getEvent(args);
          case 'create_event':
            return await this.createEvent(args);
          case 'update_event':
            return await this.updateEvent(args);
          case 'delete_event':
            return await this.deleteEvent(args);
          case 'list_todos':
            return await this.listTodos(args);
          case 'get_todo':
            return await this.getTodo(args);
          case 'create_todo':
            return await this.createTodo(args);
          case 'update_todo':
            return await this.updateTodo(args);
          case 'delete_todo':
            return await this.deleteTodo(args);
          case 'find_free_busy':
            return await this.findFreeBusy(args);
          case 'check_conflict':
            return await this.checkConflict(args);
          case 'search_events':
            return await this.searchEvents(args);
          case 'create_recurring_event':
            return await this.createRecurringEvent(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async listCalendars() {
    if (!this.calendars) {
      await this.initialize();
    }

    const calendars = this.calendars.map((cal) => ({
      id: cal.url,
      name: cal.displayName || 'Unnamed Calendar',
      description: cal.description || '',
      url: cal.url,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(calendars, null, 2),
        },
      ],
    };
  }

  async listEvents(args) {
    const { calendar_id, start_date, end_date } = args;

    const events = await this.listCalendarObjects(
      calendar_id,
      new Date(start_date),
      new Date(end_date)
    );

    const formattedEvents = events
      .filter((e) => e.icalString && e.icalString.includes('VEVENT'))
      .map((event) => {
        try {
          const parsed = ICAL.parse(event.icalString);
          const comp = new ICAL.Component(parsed);
          const vevent = comp.getFirstSubcomponent('vevent');
          if (vevent) {
            return {
              id: vevent.getFirstPropertyValue('uid'),
              title: vevent.getFirstPropertyValue('summary'),
              description: vevent.getFirstPropertyValue('description'),
              start: vevent.getFirstPropertyValue('dtstart')?.toString(),
              end: vevent.getFirstPropertyValue('dtend')?.toString(),
              location: vevent.getFirstPropertyValue('location'),
            };
          }
        } catch (e) {
          console.error('Error parsing event:', e);
        }
        return { id: event.url, data: event.icalString };
      });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(formattedEvents, null, 2),
        },
      ],
    };
  }

  async getEvent(args) {
    const { calendar_id, event_id } = args;

    // Fetch all events (wide date range)
    const events = await this.listCalendarObjects(
      calendar_id,
      new Date('2000-01-01'),
      new Date('2100-12-31')
    );

    const event = events.find((e) => {
      try {
        const parsed = ICAL.parse(e.icalString);
        const comp = new ICAL.Component(parsed);
        const vevent = comp.getFirstSubcomponent('vevent');
        return vevent && vevent.getFirstPropertyValue('uid') === event_id;
      } catch {
        return false;
      }
    });

    if (!event) {
      throw new Error('Event not found');
    }

    try {
      const parsed = ICAL.parse(event.icalString);
      const comp = new ICAL.Component(parsed);
      const vevent = comp.getFirstSubcomponent('vevent');
      if (vevent) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                id: vevent.getFirstPropertyValue('uid'),
                title: vevent.getFirstPropertyValue('summary'),
                description: vevent.getFirstPropertyValue('description'),
                start: vevent.getFirstPropertyValue('dtstart')?.toString(),
                end: vevent.getFirstPropertyValue('dtend')?.toString(),
                location: vevent.getFirstPropertyValue('location'),
              }, null, 2),
            },
          ],
        };
      }
    } catch (e) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ id: event.url, data: event.icalString }, null, 2),
          },
        ],
      };
    }
  }

  generateICS(args) {
    const { title, description, start_date, end_date, location, uid: existingUid } = args;
    // Use existing UID if provided (for updates), otherwise generate new one
    const uid = existingUid || randomUUID();

    const formatDate = (dateStr) => {
      const date = new Date(dateStr);
      return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    };

    const now = formatDate(new Date());
    const start = formatDate(start_date);
    const end = formatDate(end_date);

    let ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//CalDAV MCP//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VEVENT
UID:${uid}
DTSTAMP:${now}
DTSTART:${start}
DTEND:${end}
SUMMARY:${title}
`;

    if (description) {
      ics += `DESCRIPTION:${description}\n`;
    }
    if (location) {
      ics += `LOCATION:${location}\n`;
    }

    ics += `END:VEVENT
END:VCALENDAR`;

    return { ics, uid };
  }

  async createEvent(args) {
    const { calendar_id } = args;
    const { ics, uid } = this.generateICS(args);

    const url = calendar_id + uid + '.ics';
    const response = await this.davRequest(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'If-None-Match': '*',
      },
      body: ics,
    });

    if (!response.ok) {
      throw new Error(`Failed to create event: ${response.status} ${response.statusText}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, event_id: uid }, null, 2),
        },
      ],
    };
  }

  async updateEvent(args) {
    const { calendar_id, event_id, title, description, start_date, end_date, location } = args;

    // Find the event to get its URL and existing data
    const events = await this.listCalendarObjects(
      calendar_id,
      new Date('2000-01-01'),
      new Date('2100-12-31')
    );

    const event = events.find((e) => {
      try {
        const parsed = ICAL.parse(e.icalString);
        const comp = new ICAL.Component(parsed);
        const vevent = comp.getFirstSubcomponent('vevent');
        return vevent && vevent.getFirstPropertyValue('uid') === event_id;
      } catch {
        return false;
      }
    });

    if (!event) {
      throw new Error('Event not found');
    }

    // Parse existing event to get original values
    const parsed = ICAL.parse(event.icalString);
    const comp = new ICAL.Component(parsed);
    const vevent = comp.getFirstSubcomponent('vevent');

    // Merge: use new value if provided, otherwise keep original
    const existingTitle = vevent.getFirstPropertyValue('summary');
    const existingDescription = vevent.getFirstPropertyValue('description');
    const existingLocation = vevent.getFirstPropertyValue('location');
    const existingDtstart = vevent.getFirstPropertyValue('dtstart');
    const existingDtend = vevent.getFirstPropertyValue('dtend');

    // Convert existing ICAL time to ISO string
    const formatIcalToIso = (icalTime) => {
      if (!icalTime) return null;
      // Handle ICAL.Time object
      if (icalTime && typeof icalTime === 'object' && icalTime.year !== undefined) {
        const year = icalTime.year;
        const month = String(icalTime.month).padStart(2, '0');
        const day = String(icalTime.day).padStart(2, '0');
        const hour = String(icalTime.hour).padStart(2, '0');
        const minute = String(icalTime.minute).padStart(2, '0');
        const second = String(icalTime.second).padStart(2, '0');
        return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
      }
      // Handle string format like 20260305T153000Z
      if (typeof icalTime === 'string') {
        const match = icalTime.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
        if (match) {
          return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
        }
        return icalTime;
      }
      return String(icalTime);
    };

    const mergedTitle = title !== undefined ? title : existingTitle;
    const mergedDescription = description !== undefined ? description : existingDescription;
    const mergedLocation = location !== undefined ? location : existingLocation;
    const mergedStartDate = start_date || formatIcalToIso(existingDtstart);
    const mergedEndDate = end_date || formatIcalToIso(existingDtend);

    // Generate ICS with merged values
    const { ics } = this.generateICS({
      title: mergedTitle,
      description: mergedDescription,
      location: mergedLocation,
      start_date: mergedStartDate,
      end_date: mergedEndDate,
      uid: event_id,
    });

    // Update at the event's URL, not the calendar URL
    const absoluteUrl = this.ensureAbsoluteUrl(calendar_id, event.url);
    const response = await this.davRequest(absoluteUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
      },
      body: ics,
    });

    if (!response.ok) {
      throw new Error(`Failed to update event: ${response.status} ${response.statusText}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            event_id: event_id,
            updated: {
              title: mergedTitle,
              description: mergedDescription,
              location: mergedLocation,
              start_date: mergedStartDate,
              end_date: mergedEndDate,
            },
          }, null, 2),
        },
      ],
    };
  }

  async deleteEvent(args) {
    const { calendar_id, event_id } = args;

    const events = await this.listCalendarObjects(
      calendar_id,
      new Date('2000-01-01'),
      new Date('2100-12-31')
    );

    const event = events.find((e) => {
      try {
        const parsed = ICAL.parse(e.icalString);
        const comp = new ICAL.Component(parsed);
        const vevent = comp.getFirstSubcomponent('vevent');
        return vevent && vevent.getFirstPropertyValue('uid') === event_id;
      } catch {
        return false;
      }
    });

    if (!event) {
      throw new Error('Event not found');
    }

    const absoluteUrl = this.ensureAbsoluteUrl(calendar_id, event.url);
    const response = await this.davRequest(absoluteUrl, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error(`Failed to delete event: ${response.status} ${response.statusText}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, deleted_event_id: event_id }, null, 2),
        },
      ],
    };
  }

  // ========== VTODO (Task) Methods ==========

  async listTodos(args) {
    const { calendar_id } = args;

    const events = await this.listCalendarObjects(
      calendar_id,
      new Date('2000-01-01'),
      new Date('2100-12-31'),
      'VTODO'
    );

    const todos = events
      .filter((e) => e.icalString && e.icalString.includes('VTODO'))
      .map((event) => {
        try {
          const parsed = ICAL.parse(event.icalString);
          const comp = new ICAL.Component(parsed);
          const vtodo = comp.getFirstSubcomponent('vtodo');
          if (vtodo) {
            return {
              id: vtodo.getFirstPropertyValue('uid'),
              title: vtodo.getFirstPropertyValue('summary'),
              description: vtodo.getFirstPropertyValue('description'),
              due: vtodo.getFirstPropertyValue('due')?.toString(),
              priority: vtodo.getFirstPropertyValue('priority'),
              status: vtodo.getFirstPropertyValue('status'),
              completed: vtodo.getFirstPropertyValue('completed')?.toString(),
            };
          }
        } catch (e) {
          console.error('Error parsing todo:', e);
        }
        return { id: event.url, data: event.icalString };
      });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(todos, null, 2),
        },
      ],
    };
  }

  async getTodo(args) {
    const { calendar_id, todo_id } = args;

    const events = await this.listCalendarObjects(
      calendar_id,
      new Date('2000-01-01'),
      new Date('2100-12-31'),
      'VTODO'
    );

    const event = events.find((e) => {
      try {
        const parsed = ICAL.parse(e.icalString);
        const comp = new ICAL.Component(parsed);
        const vtodo = comp.getFirstSubcomponent('vtodo');
        return vtodo && vtodo.getFirstPropertyValue('uid') === todo_id;
      } catch {
        return false;
      }
    });

    if (!event) {
      throw new Error('Task not found');
    }

    try {
      const parsed = ICAL.parse(event.icalString);
      const comp = new ICAL.Component(parsed);
      const vtodo = comp.getFirstSubcomponent('vtodo');
      if (vtodo) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                id: vtodo.getFirstPropertyValue('uid'),
                title: vtodo.getFirstPropertyValue('summary'),
                description: vtodo.getFirstPropertyValue('description'),
                due: vtodo.getFirstPropertyValue('due')?.toString(),
                priority: vtodo.getFirstPropertyValue('priority'),
                status: vtodo.getFirstPropertyValue('status'),
                completed: vtodo.getFirstPropertyValue('completed')?.toString(),
              }, null, 2),
            },
          ],
        };
      }
    } catch (e) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ id: event.url, data: event.icalString }, null, 2),
          },
        ],
      };
    }
  }

  generateVTODO(args) {
    const { title, description, due_date, priority, status, uid: existingUid } = args;
    // Use existing UID if provided (for updates), otherwise generate new one
    const uid = existingUid || randomUUID();

    const formatDate = (dateStr) => {
      const date = new Date(dateStr);
      return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    };

    const now = formatDate(new Date());

    let ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//CalDAV MCP//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VTODO
UID:${uid}
DTSTAMP:${now}
SUMMARY:${title}
`;

    if (description) {
      ics += `DESCRIPTION:${description}\n`;
    }
    if (due_date) {
      ics += `DUE:${formatDate(due_date)}\n`;
    }
    if (priority) {
      ics += `PRIORITY:${priority}\n`;
    }
    if (status) {
      ics += `STATUS:${status}\n`;
    }

    ics += `END:VTODO
END:VCALENDAR`;

    return { ics, uid };
  }

  async createTodo(args) {
    const { calendar_id } = args;
    const { ics, uid } = this.generateVTODO(args);

    const url = calendar_id + uid + '.ics';
    const response = await this.davRequest(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'If-None-Match': '*',
      },
      body: ics,
    });

    if (!response.ok) {
      throw new Error(`Failed to create task: ${response.status} ${response.statusText}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, todo_id: uid }, null, 2),
        },
      ],
    };
  }

  async updateTodo(args) {
    const { calendar_id, todo_id, ...todoArgs } = args;

    // Find the todo to get its URL
    const events = await this.listCalendarObjects(
      calendar_id,
      new Date('2000-01-01'),
      new Date('2100-12-31'),
      'VTODO'
    );

    const todo = events.find((e) => {
      try {
        const parsed = ICAL.parse(e.icalString);
        const comp = new ICAL.Component(parsed);
        const vtodo = comp.getFirstSubcomponent('vtodo');
        return vtodo && vtodo.getFirstPropertyValue('uid') === todo_id;
      } catch {
        return false;
      }
    });

    if (!todo) {
      throw new Error('Task not found');
    }

    // Generate VTODO with existing UID to preserve it
    const { ics } = this.generateVTODO({ ...todoArgs, uid: todo_id });

    // Update at the todo's URL
    const absoluteUrl = this.ensureAbsoluteUrl(calendar_id, todo.url);
    const response = await this.davRequest(absoluteUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
      },
      body: ics,
    });

    if (!response.ok) {
      throw new Error(`Failed to update task: ${response.status} ${response.statusText}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, todo_id: todo_id }, null, 2),
        },
      ],
    };
  }

  async deleteTodo(args) {
    const { calendar_id, todo_id } = args;

    const events = await this.listCalendarObjects(
      calendar_id,
      new Date('2000-01-01'),
      new Date('2100-12-31'),
      'VTODO'
    );

    const event = events.find((e) => {
      try {
        const parsed = ICAL.parse(e.icalString);
        const comp = new ICAL.Component(parsed);
        const vtodo = comp.getFirstSubcomponent('vtodo');
        return vtodo && vtodo.getFirstPropertyValue('uid') === todo_id;
      } catch {
        return false;
      }
    });

    if (!event) {
      throw new Error('Task not found');
    }

    const absoluteUrl = this.ensureAbsoluteUrl(calendar_id, event.url);
    const response = await this.davRequest(absoluteUrl, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error(`Failed to delete task: ${response.status} ${response.statusText}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, deleted_todo_id: todo_id }, null, 2),
        },
      ],
    };
  }

  // ========== Advanced Features ==========

  async findFreeBusy(args) {
    const { calendar_id, start_date, end_date } = args;

    try {
      const result = await freeBusyQuery({
        url: calendar_id,
        timeRange: {
          start: new Date(start_date).toISOString(),
          end: new Date(end_date).toISOString(),
        },
        headers: this.authHeaders,
      });

      // Parse VFREEBUSY response
      let busyPeriods = [];
      try {
        const responseXml = await result.text();
        // Extract FREEBUSY periods from response
        const fbRegex = /<C:freebusy>([^<]+)<\/C:freebusy>/g;
        let match;
        while ((match = fbRegex.exec(responseXml)) !== null) {
          busyPeriods.push(match[1]);
        }
      } catch (e) {
        // If parsing fails, return raw response
      }

      // Also get events to calculate free time
      const events = await this.listCalendarObjects(
        calendar_id,
        new Date(start_date),
        new Date(end_date)
      );

      const busyEvents = events
        .filter((e) => e.icalString && e.icalString.includes('VEVENT'))
        .map((event) => {
          try {
            const parsed = ICAL.parse(event.icalString);
            const comp = new ICAL.Component(parsed);
            const vevent = comp.getFirstSubcomponent('vevent');
            if (vevent) {
              return {
                id: vevent.getFirstPropertyValue('uid'),
                title: vevent.getFirstPropertyValue('summary'),
                start: vevent.getFirstPropertyValue('dtstart')?.toString(),
                end: vevent.getFirstPropertyValue('dtend')?.toString(),
              };
            }
          } catch {}
          return null;
        })
        .filter(Boolean);

      // Calculate free periods
      const startTime = new Date(start_date).getTime();
      const endTime = new Date(end_date).getTime();
      const sortedEvents = busyEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

      const freeSlots = [];
      let currentTime = startTime;

      for (const event of sortedEvents) {
        const eventStart = new Date(event.start).getTime();
        const eventEnd = new Date(event.end).getTime();

        if (eventStart > currentTime) {
          freeSlots.push({
            start: new Date(currentTime).toISOString(),
            end: new Date(eventStart).toISOString(),
          });
        }
        currentTime = Math.max(currentTime, eventEnd);
      }

      if (currentTime < endTime) {
        freeSlots.push({
          start: new Date(currentTime).toISOString(),
          end: new Date(endTime).toISOString(),
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              busy_events: busyEvents,
              free_slots: freeSlots,
              total_busy: busyEvents.length,
              total_free: freeSlots.length,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to query free/busy: ${error.message}`);
    }
  }

  async checkConflict(args) {
    const { calendar_id, start_date, end_date } = args;

    const events = await this.listCalendarObjects(
      calendar_id,
      new Date(start_date),
      new Date(end_date)
    );

    const newStart = new Date(start_date).getTime();
    const newEnd = new Date(end_date).getTime();

    const conflicts = events
      .filter((e) => e.icalString && e.icalString.includes('VEVENT'))
      .map((event) => {
        try {
          const parsed = ICAL.parse(event.icalString);
          const comp = new ICAL.Component(parsed);
          const vevent = comp.getFirstSubcomponent('vevent');
          if (vevent) {
            const eventStart = new Date(vevent.getFirstPropertyValue('dtstart')).getTime();
            const eventEnd = new Date(vevent.getFirstPropertyValue('dtend')).getTime();

            // Check for overlap
            if (newStart < eventEnd && newEnd > eventStart) {
              return {
                id: vevent.getFirstPropertyValue('uid'),
                title: vevent.getFirstPropertyValue('summary'),
                start: vevent.getFirstPropertyValue('dtstart')?.toString(),
                end: vevent.getFirstPropertyValue('dtend')?.toString(),
              };
            }
          }
        } catch {}
        return null;
      })
      .filter(Boolean);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            has_conflict: conflicts.length > 0,
            conflicts: conflicts,
          }, null, 2),
        },
      ],
    };
  }

  async searchEvents(args) {
    const { calendar_id, query } = args;

    // Fetch a wide range of events
    const events = await this.listCalendarObjects(
      calendar_id,
      new Date('2000-01-01'),
      new Date('2100-12-31')
    );

    const queryLower = query.toLowerCase();
    const results = events
      .filter((e) => e.icalString && e.icalString.includes('VEVENT'))
      .map((event) => {
        try {
          const parsed = ICAL.parse(event.icalString);
          const comp = new ICAL.Component(parsed);
          const vevent = comp.getFirstSubcomponent('vevent');
          if (vevent) {
            const title = vevent.getFirstPropertyValue('summary') || '';
            const description = vevent.getFirstPropertyValue('description') || '';
            const location = vevent.getFirstPropertyValue('location') || '';

            if (
              title.toLowerCase().includes(queryLower) ||
              description.toLowerCase().includes(queryLower) ||
              location.toLowerCase().includes(queryLower)
            ) {
              return {
                id: vevent.getFirstPropertyValue('uid'),
                title: title,
                description: description,
                location: location,
                start: vevent.getFirstPropertyValue('dtstart')?.toString(),
                end: vevent.getFirstPropertyValue('dtend')?.toString(),
              };
            }
          }
        } catch {}
        return null;
      })
      .filter(Boolean);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            query: query,
            count: results.length,
            results: results,
          }, null, 2),
        },
      ],
    };
  }

  generateRecurringICS(args) {
    const { title, description, start_date, end_date, location, rrule, uid: existingUid } = args;
    const uid = existingUid || randomUUID();

    const formatDate = (dateStr) => {
      const date = new Date(dateStr);
      return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    };

    const now = formatDate(new Date());
    const start = formatDate(start_date);
    const end = formatDate(end_date);

    let ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//CalDAV MCP//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VEVENT
UID:${uid}
DTSTAMP:${now}
DTSTART:${start}
DTEND:${end}
SUMMARY:${title}
RRULE:${rrule}
`;

    if (description) {
      ics += `DESCRIPTION:${description}\n`;
    }
    if (location) {
      ics += `LOCATION:${location}\n`;
    }

    ics += `END:VEVENT
END:VCALENDAR`;

    return { ics, uid };
  }

  async createRecurringEvent(args) {
    const { calendar_id } = args;
    const { ics, uid } = this.generateRecurringICS(args);

    const url = calendar_id + uid + '.ics';
    const response = await this.davRequest(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'If-None-Match': '*',
      },
      body: ics,
    });

    if (!response.ok) {
      throw new Error(`Failed to create recurring event: ${response.status} ${response.statusText}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            event_id: uid,
            rrule: args.rrule,
          }, null, 2),
        },
      ],
    };
  }

  async start() {
    await this.initialize();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('CalDAV MCP server running on stdio');
  }
}

const server = new CalDAVServer();
server.start().catch(console.error);
