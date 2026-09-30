export const GAME_RULES = {
  timeout_seconds: 20,
  
  // LUẬT CHẶT
  three_pairs_chop_pig: false,       // 3 đôi thông KHÔNG chặt được heo
  four_chop_pig: true,               // Tứ quý chặt được heo lẻ (single 2)
  four_chop_pig_pair: true,          // Tứ quý chặt được đôi heo (pair 2)
  four_chop_three_pairs: true,       // Tứ quý chặt được 3 đôi thông
  four_pairs_chop_pig: true,         // 4 đôi thông chặt được heo lẻ
  four_pairs_chop_pig_pair: true,    // 4 đôi thông chặt được đôi heo
  four_pairs_chop_three_pairs: true, // 4 đôi thông chặt được 3 đôi thông
  four_pairs_chop_four_of_kind: true, // 4 đôi thông chặt được tứ quý
  
  // QUY TẮC BẮT ĐẦU VÁN
  must_play_3_spades_first_round: true, // Ván đầu tiên ai có 3 bích phải đánh và trong bộ bài đánh ra phải có 3 bích

  // MỨC PHẠT/ĐỀN (Tính bằng Hệ số Cược)
  penalty_multiplier: {
    base_card: 1,           // 1 lá rác còn lại trên tay = 1x cược
    pig_black: 2,           // Heo đen (Bích, Chuồn) thối phạt 2x cược
    pig_red: 4,             // Heo đỏ (Rô, Cơ) thối phạt 4x cược
    three_pairs: 3,         // 3 đôi thông thối phạt 3x cược
    four_of_a_kind: 5,      // Tứ quý thối phạt 5x cược
    four_pairs: 6,          // 4 đôi thông thối phạt 6x cược
    dragon_straight: 10,    // Sảnh rồng thối phạt 10x cược
    cong: 20                // Bị Cóng (chưa đánh được lá nào) phạt 20x cược
  }
};
