import { pmsClient } from '../api/pmsClient'

export interface CalendarRoomType {
  id: string
  name: string
  totalRooms: number
}

export interface CalendarBooking {
  id: string
  roomTypeId: string
  roomName: string
  guestFirstName: string
  guestLastName: string
  checkIn: string
  checkOut: string
  status: 'pending' | 'confirmed'
}

export interface CalendarBlock {
  id: string
  roomTypeId: string
  startDate: string
  endDate: string
  blockedCount: number
  reason: string
  createdAt: string
}

export interface CalendarData {
  roomTypes: CalendarRoomType[]
  bookings: CalendarBooking[]
  blocks: CalendarBlock[]
}

export interface CreateRoomBlockPayload {
  roomTypeId: string
  startDate: string
  endDate: string
  blockedCount: number
  reason: string
}

export const calendarService = {
  getCalendarData: (start: string, end: string) =>
    pmsClient.get<CalendarData>(`/admin/calendar?start=${start}&end=${end}`),

  createRoomBlock: (data: CreateRoomBlockPayload) =>
    pmsClient.post<CalendarBlock>('/admin/room-blocks', data),

  deleteRoomBlock: (blockId: string) =>
    pmsClient.delete(`/admin/room-blocks/${blockId}`),
}
