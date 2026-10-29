/** What a country's people are called in English, so a nationality search for "German" finds
 * Germany (VAY-2417). "CODE Word/Other word" entries, "|"-separated. */
const DEMONYMS = `AD Andorran|AE Emirati|AF Afghan|AG Antiguan|AI Anguillan|AL Albanian|AM Armenian|AO Angolan
AQ Antarctic|AR Argentine/Argentinian|AS American Samoan|AT Austrian|AU Australian|AW Aruban|AX Ålander
AZ Azerbaijani|BA Bosnian|BB Barbadian|BD Bangladeshi|BE Belgian|BF Burkinabè|BG Bulgarian|BH Bahraini
BI Burundian|BJ Beninese|BL Barthélemois|BM Bermudian|BN Bruneian|BO Bolivian|BQ Bonairean|BR Brazilian
BS Bahamian|BT Bhutanese|BW Botswanan/Motswana|BY Belarusian|BZ Belizean|CA Canadian|CC Cocos Islander
CD Congolese|CF Central African|CG Congolese|CH Swiss|CI Ivorian|CK Cook Islander|CL Chilean
CM Cameroonian|CN Chinese|CO Colombian|CR Costa Rican|CU Cuban|CV Cape Verdean|CW Curaçaoan
CX Christmas Islander|CY Cypriot|CZ Czech|DE German|DJ Djiboutian|DK Danish|DM Dominican|DO Dominican
DZ Algerian|EC Ecuadorian|EE Estonian|EG Egyptian|EH Sahrawi|ER Eritrean|ES Spanish|ET Ethiopian
FI Finnish|FJ Fijian|FK Falkland Islander|FM Micronesian|FO Faroese|FR French|GA Gabonese
GB British/English/Scottish/Welsh/Northern Irish|GD Grenadian|GE Georgian|GF French Guianese
GG Guernsey|GH Ghanaian|GI Gibraltarian|GL Greenlandic|GM Gambian|GN Guinean|GP Guadeloupean
GQ Equatorial Guinean|GR Greek|GT Guatemalan|GU Guamanian|GW Bissau-Guinean|GY Guyanese|HK Hongkonger
HN Honduran|HR Croatian|HT Haitian|HU Hungarian|ID Indonesian|IE Irish|IL Israeli|IM Manx|IN Indian
IQ Iraqi|IR Iranian|IS Icelandic|IT Italian|JE Jersey|JM Jamaican|JO Jordanian|JP Japanese|KE Kenyan
KG Kyrgyz|KH Cambodian|KI I-Kiribati|KM Comoran|KN Kittitian/Nevisian|KP North Korean|KR South Korean
KW Kuwaiti|KY Caymanian|KZ Kazakh|LA Lao/Laotian|LB Lebanese|LC Saint Lucian|LI Liechtensteiner
LK Sri Lankan|LR Liberian|LS Basotho|LT Lithuanian|LU Luxembourgish|LV Latvian|LY Libyan|MA Moroccan
MC Monégasque|MD Moldovan|ME Montenegrin|MF Saint-Martinoise|MG Malagasy|MH Marshallese|MK Macedonian
ML Malian|MM Burmese/Myanmar|MN Mongolian|MO Macanese|MP Northern Marianan|MQ Martinican|MR Mauritanian
MS Montserratian|MT Maltese|MU Mauritian|MV Maldivian|MW Malawian|MX Mexican|MY Malaysian|MZ Mozambican
NA Namibian|NC New Caledonian|NE Nigerien|NF Norfolk Islander|NG Nigerian|NI Nicaraguan|NL Dutch
NO Norwegian|NP Nepali/Nepalese|NR Nauruan|NU Niuean|NZ New Zealander/Kiwi|OM Omani|PA Panamanian
PE Peruvian|PF French Polynesian|PG Papua New Guinean|PH Filipino/Philippine|PK Pakistani|PL Polish
PM Saint-Pierrais|PN Pitcairn Islander|PR Puerto Rican|PS Palestinian|PT Portuguese|PW Palauan
PY Paraguayan|QA Qatari|RE Réunionese|RO Romanian|RS Serbian|RU Russian|RW Rwandan|SA Saudi
SB Solomon Islander|SC Seychellois|SD Sudanese|SE Swedish|SG Singaporean|SH Saint Helenian|SI Slovenian
SK Slovak|SL Sierra Leonean|SM Sammarinese|SN Senegalese|SO Somali|SR Surinamese|SS South Sudanese
ST São Toméan|SV Salvadoran|SX Sint Maartener|SY Syrian|SZ Swazi/Emaswati|TC Turks and Caicos Islander
TD Chadian|TG Togolese|TH Thai|TJ Tajik|TK Tokelauan|TL Timorese|TM Turkmen|TN Tunisian|TO Tongan
TR Turkish|TT Trinidadian/Tobagonian|TV Tuvaluan|TW Taiwanese|TZ Tanzanian|UA Ukrainian|UG Ugandan
US American|UY Uruguayan|UZ Uzbek|VA Vatican|VC Vincentian|VE Venezuelan|VG British Virgin Islander
VI U.S. Virgin Islander|VN Vietnamese|VU Ni-Vanuatu|WF Wallisian/Futunan|WS Samoan|XK Kosovar|YE Yemeni
YT Mahoran|ZA South African|ZM Zambian|ZW Zimbabwean`;

export const COUNTRY_DEMONYMS: ReadonlyMap<string, readonly string[]> = new Map(
  DEMONYMS.split(/[|\n]/).map((entry) => [entry.slice(0, 2), entry.slice(3).split("/")]),
);
