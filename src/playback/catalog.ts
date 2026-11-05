import type { AnimationWork, PlaybackEntry } from './model';

/** 初始种子片单；未改动的内置动画在打开频道后补全，广告保留指定链接。 */
export function createDefaultCatalog(): { works: AnimationWork[]; ads: PlaybackEntry[] } {
  return {
    works: [
      {
        id: 'pig-magic', title: '猪猪侠之魔幻猪猡纪',
        entries: [
          { id: 'pig-magic-1', title: '第 1 集', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=1' },
          { id: 'pig-magic-2', title: '第 2 集', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=2' },
          { id: 'pig-magic-3', title: '第 3 集', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=3' },
          { id: 'pig-magic-4', title: '第 4 集', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=4' },
          { id: 'pig-magic-5', title: '第 5 集', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=5' },
          { id: 'pig-magic-6', title: '第 6 集', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=6' },
          { id: 'pig-magic-7', title: '第 7 集', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=7' },
        ],
      },
      {
        id: 'happy-hero', title: '开心超人',
        entries: [
          { id: 'happy-hero-1', title: '开心超人的诞生（上）', url: 'https://www.bilibili.com/video/BV1QJfPYQEYg/?p=1' },
          { id: 'happy-hero-2', title: '开心超人的诞生（下）', url: 'https://www.bilibili.com/video/BV1QJfPYQEYg/?p=2' },
          { id: 'happy-hero-3', title: '飞人大炮', url: 'https://www.bilibili.com/video/BV1QJfPYQEYg/?p=3' },
          { id: 'happy-hero-4', title: '黄金UFO', url: 'https://www.bilibili.com/video/BV1QJfPYQEYg/?p=4' },
          { id: 'happy-hero-5', title: '大新闻', url: 'https://www.bilibili.com/video/BV1QJfPYQEYg/?p=5' },
          { id: 'happy-hero-6', title: '网虫日志', url: 'https://www.bilibili.com/video/BV1QJfPYQEYg/?p=6' },
          { id: 'happy-hero-7', title: '金牌卧底', url: 'https://www.bilibili.com/video/BV1QJfPYQEYg/?p=7' },
        ],
      },
      {
        id: 'hulu-brothers', title: '葫芦兄弟',
        entries: [
          { id: 'hulu-brothers-1', title: '第 1 集 神峰奇遇', url: 'https://www.bilibili.com/video/BV17GArzTEHS/?p=1' },
          { id: 'hulu-brothers-2', title: '第 2 集 七色葫芦', url: 'https://www.bilibili.com/video/BV17GArzTEHS/?p=2' },
          { id: 'hulu-brothers-3', title: '第 3 集 误入泥潭', url: 'https://www.bilibili.com/video/BV17GArzTEHS/?p=3' },
          { id: 'hulu-brothers-4', title: '第 4 集 梦窟迷境', url: 'https://www.bilibili.com/video/BV17GArzTEHS/?p=4' },
        ],
      },
      {
        id: 'black-cat-chief', title: '黑猫警长',
        entries: [
          { id: 'black-cat-chief-1', title: 'E01.痛歼搬仓鼠', url: 'https://www.bilibili.com/video/BV1zB4y1v7Jz/?p=1' },
          { id: 'black-cat-chief-2', title: 'E02.空中擒敌', url: 'https://www.bilibili.com/video/BV1zB4y1v7Jz/?p=2' },
        ],
      },
      {
        id: 'shuke-and-beta', title: '舒克和贝塔',
        entries: [
          { id: 'shuke-and-beta-1', title: 'E01.名誉(1989)', url: 'https://www.bilibili.com/video/BV1ZG411s7qB/?p=1' },
          { id: 'shuke-and-beta-2', title: 'E02.不打不相识(1990)', url: 'https://www.bilibili.com/video/BV1ZG411s7qB/?p=2' },
        ],
      },
      {
        id: 'little-carp-adventure', title: '小鲤鱼历险记',
        entries: [
          { id: 'little-carp-adventure-1', title: '第1集 泡泡闯祸', url: 'https://www.bilibili.com/video/BV16p4y1374x/?p=1' },
          { id: 'little-carp-adventure-2', title: '第2集 龙宫奇遇', url: 'https://www.bilibili.com/video/BV16p4y1374x/?p=2' },
        ],
      },
      {
        id: 'big-head-and-small-head', title: '大头儿子小头爸爸',
        entries: [
          { id: 'big-head-and-small-head-1', title: '小鸽子', url: 'https://www.bilibili.com/video/BV18x411B7vR/?p=1' },
          { id: 'big-head-and-small-head-2', title: '结婚纪念日', url: 'https://www.bilibili.com/video/BV18x411B7vR/?p=2' },
        ],
      },
      {
        id: 'blue-cat-humor', title: '蓝猫淘气3000问 幽默系列',
        entries: [
          { id: 'blue-cat-humor-001', title: '001', url: 'https://www.bilibili.com/video/BV1hJ411x76j/?p=1' },
          { id: 'blue-cat-humor-002', title: '002', url: 'https://www.bilibili.com/video/BV1hJ411x76j/?p=2' },
        ],
      },
      {
        id: 'haier-brothers', title: '海尔兄弟',
        entries: [
          { id: 'haier-brothers-1', title: 'E001', url: 'https://www.bilibili.com/video/BV1cx41137Cu/?p=1' },
          { id: 'haier-brothers-2', title: 'E002', url: 'https://www.bilibili.com/video/BV1cx41137Cu/?p=2' },
        ],
      },
      {
        id: 'sloppy-king', title: '邋遢大王奇遇记',
        entries: [
          { id: 'sloppy-king-1', title: 'E01.事出有因', url: 'https://www.bilibili.com/video/BV1xG411x7XD/?p=1' },
          { id: 'sloppy-king-2', title: 'E02.群鼠围攻', url: 'https://www.bilibili.com/video/BV1xG411x7XD/?p=2' },
        ],
      },
      {
        id: 'rainbow-cat-seven-swords', title: '虹猫蓝兔七侠传',
        entries: [
          { id: 'rainbow-cat-seven-swords-1', title: '第1集 魔道出', url: 'https://www.bilibili.com/video/BV17s411Z7am/?p=1' },
          { id: 'rainbow-cat-seven-swords-2', title: '第2集 火海突围', url: 'https://www.bilibili.com/video/BV17s411Z7am/?p=2' },
        ],
      },
      {
        id: 'little-chef', title: '神厨小福贵',
        entries: [
          { id: 'little-chef-1', title: '第1集', url: 'https://www.bilibili.com/video/BV11t411p7DV/?p=1' },
          { id: 'little-chef-2', title: '第2集', url: 'https://www.bilibili.com/video/BV11t411p7DV/?p=2' },
        ],
      },
      {
        id: 'divine-weapons', title: '神兵小将',
        entries: [
          { id: 'divine-weapons-1', title: '第1集 小英雄问天', url: 'https://www.bilibili.com/video/BV1SFAszgEPe/?p=1' },
          { id: 'divine-weapons-2', title: '第2集 团结就是力量', url: 'https://www.bilibili.com/video/BV1SFAszgEPe/?p=2' },
        ],
      },
      {
        id: 'go-board', title: '围棋少年',
        entries: [
          { id: 'go-board-1', title: '第1集', url: 'https://www.bilibili.com/video/BV19W411u7qA/?p=1' },
          { id: 'go-board-2', title: '第2集', url: 'https://www.bilibili.com/video/BV19W411u7qA/?p=2' },
        ],
      },
      {
        id: 'xiangqi-king', title: '象棋王',
        entries: [
          { id: 'xiangqi-king-1', title: '第1集', url: 'https://www.bilibili.com/video/BV1D4411b7TJ/?p=1' },
          { id: 'xiangqi-king-2', title: '第2集', url: 'https://www.bilibili.com/video/BV1D4411b7TJ/?p=2' },
        ],
      },
      {
        id: 'sanmao-wandering', title: '三毛流浪记',
        entries: [
          { id: 'sanmao-wandering-1', title: '第一集', url: 'https://www.bilibili.com/video/BV1ix411K72P/?p=1' },
          { id: 'sanmao-wandering-2', title: '第二集', url: 'https://www.bilibili.com/video/BV1ix411K72P/?p=2' },
        ],
      },
      {
        id: 'journey-to-the-west-1999', title: '西游记',
        entries: [
          { id: 'journey-to-the-west-1999-1', title: '第1集 猴王出世', url: 'https://www.bilibili.com/video/BV1QU4y1h74T/?p=1' },
          { id: 'journey-to-the-west-1999-2', title: '第2集 龙宫取宝', url: 'https://www.bilibili.com/video/BV1QU4y1h74T/?p=2' },
        ],
      },
      {
        id: 'goat-happy-year', title: '喜羊羊与灰太狼之羊羊快乐的一年',
        entries: [
          { id: 'goat-happy-year-1', title: '01.快乐时光', url: 'https://www.bilibili.com/video/BV1fPQcBFERF/?p=1' },
          { id: 'goat-happy-year-2', title: '02.先知的梦', url: 'https://www.bilibili.com/video/BV1fPQcBFERF/?p=2' },
        ],
      },
      {
        id: 'lolo-adventure', title: '百变机兽之洛洛历险记',
        entries: [
          { id: 'lolo-adventure-1', title: '第一集 游戏高手', url: 'https://www.bilibili.com/video/BV1Gx41177Vt/?p=1' },
          { id: 'lolo-adventure-2', title: '第二集 时光之城', url: 'https://www.bilibili.com/video/BV1Gx41177Vt/?p=2' },
        ],
      },
      {
        id: 'super-beasts', title: '超兽武装',
        entries: [
          { id: 'super-beasts-1', title: '超兽武装 第1集 平行宇宙', url: 'https://www.bilibili.com/video/BV1zKQGBtEMy/' },
          { id: 'super-beasts-2', title: '超兽武装 第2集 玄易大师', url: 'https://www.bilibili.com/video/BV1CdQ3BNEQT/' },
        ],
      },
      {
        id: 'happy-star-cat', title: '快乐星猫（第一季）',
        entries: [
          { id: 'happy-star-cat-1', title: '01 快乐星猫', url: 'https://www.bilibili.com/video/BV12x411x79w/?p=1' },
          { id: 'happy-star-cat-2', title: '02 快乐星猫', url: 'https://www.bilibili.com/video/BV12x411x79w/?p=2' },
        ],
      },
      {
        id: 'bear-chronicles-s1', title: '熊出没（神奇宝物第一季）',
        entries: [
          { id: 'bear-chronicles-s1-1', title: '第01集', url: 'https://www.bilibili.com/video/BV1axHV6EELf/?p=1' },
          { id: 'bear-chronicles-s1-2', title: '第02集', url: 'https://www.bilibili.com/video/BV1axHV6EELf/?p=2' },
        ],
      },
      {
        id: 'big-eared-tutu-s1', title: '大耳朵图图（第一季）',
        entries: [
          { id: 'big-eared-tutu-s1-1', title: '第1集 出生的秘密', url: 'https://www.bilibili.com/video/BV1e66yYREiL/' },
          { id: 'big-eared-tutu-s1-2', title: '第2集 图图的生日礼物', url: 'https://www.bilibili.com/video/BV1MDHg6vEfJ/' },
        ],
      },
      {
        id: 'tianyan', title: '天眼',
        entries: [
          { id: 'tianyan-1', title: '第001集', url: 'https://www.bilibili.com/video/BV1Ux411j7Rh/?p=1' },
          { id: 'tianyan-2', title: '第002集', url: 'https://www.bilibili.com/video/BV1Ux411j7Rh/?p=2' },
        ],
      },
      {
        id: 'doraemon-2014', title: '哆啦A梦新番',
        entries: [
          { id: 'doraemon-2014-353', title: '353 好房子，坏房子／○△□恐怖症', url: 'https://www.bilibili.com/video/BV1cx411z77C/?p=1' },
          { id: 'doraemon-2014-354', title: '354 逃离地球计划／禁语马克笔', url: 'https://www.bilibili.com/video/BV1cx411z77C/?p=2' },
        ],
      },
      {
        id: 'smurfs-season-1', title: '蓝精灵',
        entries: [
          { id: 'smurfs-season-1-01', title: '第 1 集', url: 'https://www.bilibili.com/video/BV1Xx411n79s/?p=1' },
          { id: 'smurfs-season-1-02', title: '第 2 集', url: 'https://www.bilibili.com/video/BV1Xx411n79s/?p=2' },
        ],
      },
      {
        id: 'digimon-adventure', title: '数码宝贝第一部',
        entries: [
          { id: 'digimon-adventure-01', title: '第 1 集 漂流？冒险之岛！', url: 'https://www.bilibili.com/video/BV1bKE268EyZ/?p=1' },
          { id: 'digimon-adventure-02', title: '第 2 集 爆裂进化！暴龙兽', url: 'https://www.bilibili.com/video/BV1bKE268EyZ/?p=2' },
        ],
      },
      {
        id: 'pokemon-original-series', title: '精灵宝可梦无印篇',
        entries: [
          { id: 'pokemon-original-01', title: '第 1 集', url: 'https://www.bilibili.com/video/BV1HD4y1j7Q9/' },
          { id: 'pokemon-original-02', title: '第 2 集 神奇宝贝中心大对决！', url: 'https://www.bilibili.com/video/BV1aeXDYTETB/' },
        ],
      },
      {
        id: 'krtek-mole', title: '鼹鼠的故事',
        entries: [
          { id: 'krtek-mole-01', title: '鼹鼠和泉水', url: 'https://www.bilibili.com/video/BV1xNCGBSECh/?p=1' },
          { id: 'krtek-mole-02', title: '鼹鼠过圣诞节', url: 'https://www.bilibili.com/video/BV1xNCGBSECh/?p=2' },
        ],
      },
      {
        id: 'tom-and-jerry-classics', title: '猫和老鼠经典短篇',
        entries: [
          { id: 'tom-and-jerry-baby-puss', title: '宝贝猫咪（Baby Puss，国语）', url: 'https://www.bilibili.com/video/BV14VQPBQEkz/' },
          { id: 'tom-and-jerry-quiet-please', title: '请安静！（Quiet Please!）', url: 'https://www.bilibili.com/video/BV1YRPpzUE6Y/' },
        ],
      },
      {
        id: 'dragon-warrior-season-1', title: '魔神英雄传／神龙斗士',
        entries: [
          { id: 'dragon-warrior-season-1-01', title: '第 1 集：神龙斗士01', url: 'https://www.bilibili.com/video/BV1uEktBAEnT/' },
          { id: 'dragon-warrior-season-1-02', title: '第 2 集：神龙斗士02', url: 'https://www.bilibili.com/video/BV1uEktBAEss/' },
        ],
      },
    ],
    ads: [
      { id: 'wash-feet', title: '妈妈，洗脚', url: 'https://www.bilibili.com/video/BV13r4y117HE/' },
      { id: 'care-elders', title: '关爱老人，用心开始', url: 'https://www.bilibili.com/video/BV18s41167NT/' },
      { id: 'rubbish-holiday', title: '垃圾在度假', url: 'https://www.bilibili.com/video/BV12y4y1C7DT/' },
      { id: 'save-water', title: '节约创造价值之节约用水篇', url: 'https://www.bilibili.com/video/BV1os411Y7JN/' },
      { id: 'polluted-painting', title: '污染的画', url: 'https://www.bilibili.com/video/BV1HT4y1w75F/' },
      { id: 'ethics-should', title: '职业道德建设：《应该的》', url: 'https://www.bilibili.com/video/BV1WsozBZE4F/' },
      { id: 'honesty-breakfast', title: '诚信公益广告《早餐店篇》', url: 'https://www.bilibili.com/video/BV1LW411N7wm/' },
      { id: 'virtue-seat', title: '公德比赛（让座篇）', url: 'https://www.bilibili.com/video/BV1F44y1s7b1/' },
      { id: 'volunteer-children', title: '志愿者（留守儿童篇）', url: 'https://www.bilibili.com/video/BV1Gs411i76K/' },
      { id: 'civic-dining', title: '文明餐桌，从我做起', url: 'https://www.bilibili.com/video/BV1Ue411V7gD/' },
      { id: 'good-deeds-neighbor', title: '善行无迹（邻居篇）', url: 'https://www.bilibili.com/video/BV1Fx411i7UJ/?p=1' },
      { id: 'BV1v4411o7pw', title: '保护生物多样性共创生态文明公益广告', url: 'https://www.bilibili.com/video/BV1v4411o7pw/' },
      { id: 'BV15b411u7Ew', title: '国家森林防火公益广告', url: 'https://www.bilibili.com/video/BV15b411u7Ew/' },
      { id: 'BV19E411y7Gm', title: '交通安全公益广告西游记篇', url: 'https://www.bilibili.com/video/BV19E411y7Gm/' },
      { id: 'BV1Gg411M7XX', title: '【央视】珍爱生命 预防溺水 央视新闻频道公益广告', url: 'https://www.bilibili.com/video/BV1Gg411M7XX/' },
      { id: 'BV1rN4y1g7Z6', title: '环保公益广告《塑料》', url: 'https://www.bilibili.com/video/BV1rN4y1g7Z6/' },
      { id: 'thai-smoking-children', title: '泰国禁烟公益广告：Smoking Children', url: 'https://www.bilibili.com/video/BV1jx411E7gC/' },
      { id: 'uk-malaria-awareness', title: '英国公益广告：小心疟疾（1983）', url: 'https://www.bilibili.com/video/BV1ga411H7XZ/' },
      { id: 'brazil-seatbelt', title: '巴西交通安全公益广告：请系好安全带', url: 'https://www.bilibili.com/video/BV1ie411j7bx/' },
      { id: 'australia-pet-toy', title: '澳大利亚动物保护公益广告：宠物玩具（1999）', url: 'https://www.bilibili.com/video/BV1enHp6CERd/' },
      { id: 'korea-anti-violence', title: '韩国公益广告：暴力不是玩笑（2017）', url: 'https://www.bilibili.com/video/BV1MQ4y1B7zH/' },
      { id: 'wwf-love-or-lose', title: 'WWF 公益广告：爱它或失去它（中英双字）', url: 'https://www.bilibili.com/video/BV1jX89zrEBX/' },
    ],
  };
}
