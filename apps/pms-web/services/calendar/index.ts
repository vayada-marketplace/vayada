import { pmsClient } from '../api/pmsClient'

export interface CalendarRoomType {
  id: string
  name: string
  totalRooms: number
  baseRate: number
  currency: string
}

export interface CalendarRoom {
  id: string
  roomTypeId: string
  roomTypeName: string
  roomNumber: string
  floor: string
  status: string
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
  roomId: string | null
  roomNumber: string | null
  channel: string
  bookingReference: string
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
  rooms: CalendarRoom[]
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

export interface CreateAdminBookingPayload {
  roomId: string
  guestFirstName: string
  guestLastName: string
  guestEmail: string
  guestPhone: string
  specialRequests: string
  checkIn: string
  checkOut: string
  adults: number
  children: number
  nightlyRate: number | null
  channel: string
}

export const calendarService = {
  getCalendarData: (start: string, end: string) =>
    pmsClient.get<CalendarData>(`/admin/calendar?start=${start}&end=${end}`),

  createRoomBlock: (data: CreateRoomBlockPayload) =>
    pmsClient.post<CalendarBlock>('/admin/room-blocks', data),

  deleteRoomBlock: (blockId: string) =>
    pmsClient.delete(`/admin/room-blocks/${blockId}`),

  createAdminBooking: (data: CreateAdminBookingPayload) =>
    pmsClient.post('/admin/bookings', data),
}
